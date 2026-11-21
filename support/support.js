const form = document.querySelector('#support-form');
const amountButtons = document.querySelectorAll('.amount-option');
const customAmount = document.querySelector('#custom-amount');
const supportMessage = document.querySelector('#support-message');
const payButton = document.querySelector('#pay-button');

let selectedAmount = 50;

function setMessage(message, type = 'info') {
  supportMessage.textContent = message;
  supportMessage.className = `support-message ${type}`;
}

function applySelection(amount) {
  selectedAmount = Number(amount) || 0;
  amountButtons.forEach((button) => {
    const isSelected = Number(button.dataset.amount) === selectedAmount;
    button.classList.toggle('is-selected', isSelected);
  });
  if (selectedAmount > 0) {
    customAmount.value = selectedAmount;
  }
}

amountButtons.forEach((button) => {
  button.addEventListener('click', () => {
    applySelection(button.dataset.amount);
    setMessage('');
  });
});

customAmount.addEventListener('input', () => {
  const value = Number(customAmount.value);
  if (!Number.isFinite(value) || value <= 0) {
    setMessage('Enter a valid amount of at least ₹50.', 'error');
    return;
  }
  setMessage('');
  selectedAmount = value;
  amountButtons.forEach((button) => {
    button.classList.toggle('is-selected', Number(button.dataset.amount) === value);
  });
});

function loadRazorpay() {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (window.Razorpay) {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Could not load Razorpay checkout.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay checkout.'));
    document.body.appendChild(script);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const amount = Number(customAmount.value);
  if (!Number.isFinite(amount) || amount < 50) {
    setMessage('Please enter a contribution amount of at least ₹50.', 'error');
    customAmount.focus();
    return;
  }

  const name = document.querySelector('#support-name').value.trim();
  const email = document.querySelector('#support-email').value.trim();
  const note = document.querySelector('#support-note').value.trim();

  payButton.disabled = true;
  payButton.textContent = 'Preparing secure payment...';
  setMessage('Preparing your secure payment…', 'info');

  try {
    const amountInPaise = Math.round(amount * 100);
    const orderResponse = await fetch('/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `support-${Date.now()}`,
        name,
        email,
        note
      })
    });

    const orderData = await orderResponse.json().catch(() => ({}));
    if (!orderResponse.ok || !orderData.order_id || !orderData.keyId) {
      throw new Error(orderData.error || 'Unable to create the payment order right now.');
    }

    await loadRazorpay();

    const checkout = new window.Razorpay({
      key: orderData.keyId,
      amount: orderData.amount,
      currency: orderData.currency,
      name: 'Good things to know today',
      description: 'Support Our Platform',
      order_id: orderData.order_id,
      prefill: {
        name: name || '',
        email: email || ''
      },
      theme: {
        color: '#27725d'
      },
      handler: async (response) => {
        try {
          const verifyResponse = await fetch('/api/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order_id: orderData.order_id,
              payment_id: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              amount: amountInPaise
            })
          });

          const verifyData = await verifyResponse.json().catch(() => ({}));
          if (!verifyResponse.ok || !verifyData.ok) {
            throw new Error(verifyData.error || 'Payment verification failed.');
          }

          const cleanName = encodeURIComponent(name || 'Supporter');
          window.location.href = `./success.html?amount=${encodeURIComponent(String(amount))}&name=${cleanName}&payment_id=${encodeURIComponent(response.razorpay_payment_id || '')}`;
        } catch (error) {
          window.location.href = `./cancelled.html?error=${encodeURIComponent(error.message || 'Payment verification failed')}`;
        }
      },
      modal: {
        ondismiss: () => {
          payButton.disabled = false;
          payButton.textContent = 'Continue to secure payment';
          setMessage('Payment cancelled. You can try again anytime.', 'error');
        }
      }
    });

    checkout.on('payment.failed', (response) => {
      const failureReason = response.error && response.error.description ? response.error.description : 'Payment failed. Please try again.';
      window.location.href = `./cancelled.html?error=${encodeURIComponent(failureReason)}`;
    });

    checkout.open();
  } catch (error) {
    payButton.disabled = false;
    payButton.textContent = 'Continue to secure payment';
    setMessage(error.message || 'Something went wrong while preparing your payment.', 'error');
  }
});

applySelection(selectedAmount);
