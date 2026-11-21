const params = new URLSearchParams(window.location.search);
const amount = params.get('amount');
const name = params.get('name');
const amountNode = document.querySelector('#amount-value');
const nameNode = document.querySelector('#supporter-name');

if (amountNode && amount) {
  amountNode.textContent = `₹${Number(amount).toLocaleString('en-IN')}`;
}
if (nameNode) {
  const displayName = name ? decodeURIComponent(name) : 'Supporter';
  nameNode.textContent = `${displayName}, thanks for keeping the brief going.`;
}
