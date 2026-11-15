const storyList = document.querySelector("#story-list");
const categoryNav = document.querySelector("#category-nav");
const sourceFilter = document.querySelector("#source-filter");
const searchInput = document.querySelector("#search");
const sortOrder = document.querySelector("#sort-order");
const storyCount = document.querySelector("#story-count");
const updatedAt = document.querySelector("#updated-at");
const emptyState = document.querySelector("#empty-state");
const errorState = document.querySelector("#error-state");
const loadingState = storyList.querySelector(".loading-state");
const categoryColors = ["#27725d", "#e27b4f", "#477a93", "#9b6b46", "#bd664c"];
const categoryPriority = {
  World: 0,
  Business: 1,
  Science: 2,
  Technology: 3,
};

let stories = [];
let activeCategory = "all";

async function recordPageView() {
  const config = window.FIELDNOTES_CONFIG || {};
  if (typeof config.counterApiUrl !== "string" || !config.counterApiUrl.trim()) return;

  try {
    const response = await fetch(config.counterApiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "view",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Counter returned ${response.status}`);
    const counts = await response.json();
    if (!Number.isSafeInteger(counts.total) || !Number.isSafeInteger(counts.today)) return;
    document.querySelector("#total-views").textContent = counts.total.toLocaleString();
    document.querySelector("#today-views").textContent = counts.today.toLocaleString();
  } catch (error) {
    console.warn("Could not load page-view counts:", error);
  }
}

function configureDonationLink() {
  const link = document.querySelector("#donate-link");
  const config = window.FIELDNOTES_CONFIG || {};
  const donationUrl = typeof config.donationUrl === "string" ? config.donationUrl.trim() : "";
  const upiId = typeof config.upiId === "string" ? config.upiId.trim() : "";
  const payeeName = typeof config.payeeName === "string" ? config.payeeName.trim() : "";

  try {
    const parsedUrl = new URL(donationUrl);
    if (parsedUrl.protocol === "https:") {
      link.href = parsedUrl.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.querySelector("#donate-label").textContent = "Support this brief";
      link.hidden = false;
      return;
    }
  } catch {
    // Continue to the UPI option when no HTTPS payment page is configured.
  }

  if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(upiId)) return;
  const payment = new URLSearchParams({ pa: upiId, cu: "INR", tn: "Support Fieldnotes" });
  if (payeeName) payment.set("pn", payeeName);
  link.href = `upi://pay?${payment.toString()}`;
  document.querySelector("#donate-label").textContent = "Donate via UPI";
  link.hidden = false;
}

function safeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = safeDate(value);
  if (!date) return "DATE UNKNOWN";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date).toUpperCase();
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function categorySortValue(name) {
  const priority = categoryPriority[name] ?? Number.MAX_SAFE_INTEGER;
  return [priority, name || ""].join("|");
}

function populateFilters(data) {
  const categories = new Map();
  const sources = new Set();
  for (const story of stories) {
    if (story.category) categories.set(story.category, (categories.get(story.category) || 0) + 1);
    for (const source of story.sources || []) {
      const sourceName = source.source || source.name;
      if (sourceName) sources.add(sourceName);
    }
  }

  categoryNav.replaceChildren();
  const allButton = makeCategoryButton("Everything", "all", stories.length);
  categoryNav.append(allButton);
  [...categories.entries()].sort(([left], [right]) => {
    const leftValue = categorySortValue(left);
    const rightValue = categorySortValue(right);
    return leftValue.localeCompare(rightValue);
  }).forEach(([name, count], index) => {
    categoryNav.append(makeCategoryButton(name, name, count, categoryColors[index % categoryColors.length]));
  });

  sourceFilter.replaceChildren();
  sourceFilter.append(new Option("All sources", "all"));
  const configuredSources = Array.isArray(data.sources) ? data.sources : [];
  const sourceNames = new Set([...sources, ...configuredSources.map((source) => source.name).filter(Boolean)]);
  [...sourceNames].sort((a, b) => a.localeCompare(b)).forEach((name) => sourceFilter.append(new Option(name, name)));
}

function makeCategoryButton(label, value, count, color) {
  const button = makeElement("button", `category-button${value === activeCategory ? " is-active" : ""}`);
  button.type = "button";
  button.dataset.category = value;
  button.setAttribute("aria-pressed", String(value === activeCategory));
  if (color) button.style.setProperty("--category-color", color);
  button.append(document.createTextNode(label));
  const countElement = makeElement("span", "category-count", String(count));
  button.append(countElement);
  return button;
}

function visibleStories() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const selectedSource = sourceFilter.value;
  const result = stories.filter((story) => {
    const categoryMatches = activeCategory === "all" || story.category === activeCategory;
    const sources = story.sources || [];
    const sourceMatches = selectedSource === "all" || sources.some((source) => (source.source || source.name) === selectedSource);
    const sourceText = sources.map((source) => `${source.source || source.name} ${source.title} ${source.excerpt}`).join(" ");
    const searchable = `${story.title} ${story.summary} ${sourceText} ${story.category}`.toLocaleLowerCase();
    return categoryMatches && sourceMatches && (!query || searchable.includes(query));
  });
  result.sort((first, second) => {
    const firstPriority = categoryPriority[first.category] ?? Number.MAX_SAFE_INTEGER;
    const secondPriority = categoryPriority[second.category] ?? Number.MAX_SAFE_INTEGER;
    const categoryDelta = firstPriority - secondPriority;
    if (categoryDelta !== 0) return categoryDelta;
    const direction = sortOrder.value === "oldest" ? 1 : -1;
    return direction * ((safeDate(first.publishedAt)?.getTime() || 0) - (safeDate(second.publishedAt)?.getTime() || 0));
  });
  return result;
}

function makeStoryTeaser(story) {
  const raw = (story.summary || story.excerpt || story.title || "").replace(/https?:\/\/\S+/gi, "");
  const cleaned = raw.replace(/\s+/g, " ").replace(/[\u2018\u2019\u201C\u201D]/g, "").trim();
  if (!cleaned) return [];

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 10) return [cleaned];

  const chunkCount = Math.min(5, Math.max(2, Math.ceil(words.length / 12)));
  const chunkSize = Math.ceil(words.length / chunkCount);
  const lines = [];

  for (let index = 0; index < words.length; index += chunkSize) {
    const chunk = words.slice(index, index + chunkSize).join(" ");
    if (chunk) lines.push(chunk);
    if (lines.length >= 5) break;
  }

  return lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function renderStory(story, index) {
  const article = makeElement("article", "story-card");
  article.style.animationDelay = `${Math.min(index, 8) * 35}ms`;
  const meta = makeElement("div", "story-meta");
  const category = makeElement("span", "story-category", story.category || "General");
  const date = makeElement("time", "story-date", formatDate(story.publishedAt));
  const parsedDate = safeDate(story.publishedAt);
  if (parsedDate) date.dateTime = parsedDate.toISOString();
  meta.append(category, date);

  const storyUrl = (() => {
    const candidate = story.url || story.link || (Array.isArray(story.sources) ? story.sources[0]?.url || story.sources[0]?.link : "");
    return typeof candidate === "string" && /^https?:\/\//i.test(candidate) ? candidate : "";
  })();

  const body = makeElement("div", "story-body");
  const title = makeElement("h3", "story-title");
  const titleLink = makeElement("a", "", story.title || "Untitled story");
  if (storyUrl) {
    titleLink.href = storyUrl;
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
  } else {
    titleLink.href = "#";
    titleLink.setAttribute("aria-disabled", "true");
    titleLink.tabIndex = -1;
    titleLink.style.pointerEvents = "none";
  }
  title.append(titleLink);
  body.append(title);

  const teaserLines = makeStoryTeaser(story);
  if (teaserLines.length) {
    const teaser = makeElement("div", "story-summary");
    teaserLines.forEach((line) => teaser.append(makeElement("span", "story-summary-line", line)));
    body.append(teaser);
  }

  if (story.summary) body.append(makeElement("p", "story-excerpt", story.summary));
  for (const coverage of story.additionalCoverage || []) {
    if (!coverage.excerpt) continue;
    const additional = makeElement("p", "story-excerpt additional-coverage");
    additional.append(makeElement("strong", "", `Also reported by ${coverage.source || coverage.name}: `));
    additional.append(document.createTextNode(coverage.excerpt));
    body.append(additional);
  }

  const sourceLine = makeElement("div", "story-source");
  const sources = story.sources || [];
  sourceLine.append(makeElement("span", "", sources.length > 1 ? "Coverage:" : "Source:"));
  sources.forEach((source, sourceIndex) => {
    if (sourceIndex > 0) sourceLine.append(makeElement("span", "source-dot"));
    const sourceLink = makeElement("a", "read-link", `${source.source || source.name || "Original source"} ↗`);
    sourceLink.href = source.url;
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceLine.append(sourceLink);
  });
  body.append(sourceLine);
  article.append(meta, body);
  return article;
}

function render() {
  const results = visibleStories();
  storyCount.textContent = `${results.length} ${results.length === 1 ? "story" : "stories"}`;
  const countElement = categoryNav.querySelector('[data-count="all"]');
  if (countElement) countElement.textContent = String(stories.length);
  categoryNav.querySelectorAll("[data-category]").forEach((button) => {
    const category = button.dataset.category;
    const count = category === "all" ? stories.length : stories.filter((story) => story.category === category).length;
    button.querySelector(".category-count").textContent = String(count);
  });
  storyList.replaceChildren(...results.map(renderStory));
  emptyState.hidden = results.length !== 0;
}

async function loadBrief() {
  storyList.setAttribute("aria-busy", "true");
  errorState.hidden = true;
  emptyState.hidden = true;
  if (!stories.length) storyList.replaceChildren(loadingState);
  try {
    const response = await fetch("data/feeds.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Feed data returned ${response.status}`);
    const data = await response.json();
    stories = Array.isArray(data.groups)
      ? data.groups
          .filter((group) => group && Array.isArray(group.sources) && group.sources.some((source) => /^https?:\/\//i.test(source.url || "")))
          .map((group) => ({
            ...group,
            url: group.url || group.sources?.[0]?.url || "",
            source: group.source || group.sources?.[0]?.source || group.sources?.[0]?.name || "",
          }))
      : (Array.isArray(data.entries) ? data.entries.filter((story) => story && /^https?:\/\//i.test(story.url || "")).map((story) => ({
          id: story.url,
          title: story.title,
          url: story.url,
          category: story.category,
          publishedAt: story.publishedAt,
          summary: story.excerpt,
          sources: [{ name: story.source, url: story.url, title: story.title, excerpt: story.excerpt }],
        })) : []);
    populateFilters(data);
    const generated = safeDate(data.generatedAt);
    updatedAt.textContent = generated ? `UPDATED ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(generated)}` : "LATEST EDITION";
    document.querySelector("#issue-number").textContent = String(new Date().getDate()).padStart(2, "0");
    render();
  } catch (error) {
    console.error("Could not load the brief:", error);
    storyList.replaceChildren();
    errorState.hidden = false;
  } finally {
    storyList.setAttribute("aria-busy", "false");
  }
}

categoryNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  categoryNav.querySelectorAll("[data-category]").forEach((item) => {
    const isActive = item === button;
    item.classList.toggle("is-active", isActive);
    item.setAttribute("aria-pressed", String(isActive));
  });
  render();
});

searchInput.addEventListener("input", render);
sourceFilter.addEventListener("change", render);
sortOrder.addEventListener("change", render);
document.querySelector("#reset-filters").addEventListener("click", () => {
  activeCategory = "all";
  searchInput.value = "";
  sourceFilter.value = "all";
  categoryNav.querySelectorAll("[data-category]").forEach((button) => {
    const isActive = button.dataset.category === "all";
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  render();
});
document.querySelector("#retry-load").addEventListener("click", loadBrief);

configureDonationLink();
recordPageView();
loadBrief();