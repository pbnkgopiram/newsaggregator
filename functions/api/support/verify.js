import { createHmac, timingSafeEqual } from 'node:crypto';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  const keySecret = env.RAZORPAY_KEY_SECRET || '';
  if (!keySecret) {
    return Response.json({ error: 'Razorpay verification is not configured yet.' }, { status: 503 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const orderId = typeof payload.order_id === 'string' ? payload.order_id.trim() : '';
  const paymentId = typeof payload.payment_id === 'string' ? payload.payment_id.trim() : '';
  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  const amount = Number(payload.amount);

  if (!orderId || !paymentId || !signature || !Number.isFinite(amount) || amount < 50) {
    return Response.json({ error: 'Missing payment verification data.' }, { status: 400 });
  }

  const expectedSignature = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return Response.json({ error: 'Payment signature verification failed.' }, { status: 400 });
  }

  return Response.json({ ok: true, message: 'Payment verified successfully.' });
}
