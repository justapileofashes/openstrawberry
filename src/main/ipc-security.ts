export function assertTrustedRendererId(senderId: number, trustedRendererId: number | undefined): void {
  if (!trustedRendererId || senderId !== trustedRendererId) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
}
