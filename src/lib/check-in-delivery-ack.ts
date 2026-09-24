const MAX_ACK_BYTES = 8192;

export type CheckInDeliveryAck = {
  ok: true;
  sent: boolean;
  alreadySent: boolean;
  deliveryId: string;
};

export async function readCheckInDeliveryAck(response: Response, expectedDeliveryId: string): Promise<CheckInDeliveryAck | null> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ACK_BYTES)) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ACK_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const ack = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as Record<string, unknown>;
    if (ack.ok !== true || ack.deliveryId !== expectedDeliveryId
      || typeof ack.sent !== "boolean" || typeof ack.alreadySent !== "boolean"
      || ack.sent === ack.alreadySent) return null;
    return ack as CheckInDeliveryAck;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
