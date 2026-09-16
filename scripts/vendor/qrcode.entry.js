// Entry for vendor/qrcode.js (see scripts/build-vendor.mjs).
// A QR encoder for the authenticator-app enrollment step of the email wallet
// (assets/email-login.js renders the otpauth:// URI as an SVG so desktop
// users can scan it). Loaded on demand, only on that step.
import qrcode from "qrcode-generator";

/** SVG markup for `text` (error correction M, auto size). */
export function qrSvg(text, cellSize = 4, margin = 8) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}
