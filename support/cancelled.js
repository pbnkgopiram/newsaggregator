const params = new URLSearchParams(window.location.search);
const messageNode = document.querySelector('#cancel-message');
const reason = params.get('error');
if (messageNode) {
  messageNode.textContent = reason ? `No charge was made. ${decodeURIComponent(reason)}` : 'No charge was made to your payment method.';
}
