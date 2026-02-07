export function twimlConnectStream(wsUrl, parameters = {}) {
  const entries = Object.entries(parameters || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const hasParams = entries.length > 0;
  const paramLines = entries.map(([name, value]) => (
    `      <Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`
  ));

  // Twilio expects valid XML TwiML
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    hasParams ? `    <Stream url="${escapeXml(wsUrl)}">` : `    <Stream url="${escapeXml(wsUrl)}" />`,
    ...paramLines,
    hasParams ? '    </Stream>' : null,
    '  </Connect>',
    '</Response>'
  ].filter(Boolean).join('\n');
}

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
