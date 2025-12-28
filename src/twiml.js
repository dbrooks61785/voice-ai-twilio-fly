export function twimlConnectStream(wsUrl) {
  // Twilio expects valid XML TwiML
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    '    <Stream url="' + escapeXml(wsUrl) + '" />',
    '  </Connect>',
    '</Response>'
  ].join('\n');
}

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
