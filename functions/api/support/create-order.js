export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const keyId = env.RAZORPAY_KEY_ID || '';
  const keySecret = env.RAZORPAY_KEY_SECRET || '';
  if (!keyId || !keySecret) {
    return Response.json({ error: 'Razorpay credentials are not configured yet.' }, { status: 503 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const amount = Number(payload.amount);
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';

  if (!Number.isFinite(amount) || amount < 50 || amount > 10000000) {
    return Response.json({ error: 'Contribution amount must be between ₹50 and ₹1,00,000.' }, { status: 400 });
  }

  const orderPayload = {
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt: `support-${Date.now()}`,
    notes: {
      name: name || 'Guest supporter',
      email: email || 'not provided',
      note: note || 'One-time support'
    }
  };

  try {
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
      },
      body: JSON.stringify(orderPayload)
    });

    const order = await response.json();
    if (!response.ok) {
      return Response.json({ error: order && order.error ? order.error.description : 'Unable to create Razorpay order.' }, { status: 502 });
    }

    return Response.json({
      ok: true,
      keyId,
      amount: order.amount,
      currency: order.currency,
      order
    });
  } catch (error) {
    return Response.json({ error: 'Payment gateway is currently unavailable.' }, { status: 502 });
  }
}
