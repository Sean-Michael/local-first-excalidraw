export function orderConfirmation(orderId: string, totalCents: number) {
  const total = (totalCents / 100).toFixed(2);
  return {
    subject: `Your shopapp order ${orderId.slice(0, 8)} is confirmed`,
    html: `<p>Thanks for your order. We charged <b>$${total}</b>.</p>`,
  };
}
