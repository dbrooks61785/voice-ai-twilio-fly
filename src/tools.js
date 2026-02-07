export const tools = [
  {
    type: "function",
    name: "create_intake_record",
    description: "Create an intake record in the system of record (CRM/DB).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        service_type: { type: "string" },
        job_city: { type: "string" },
        job_state: { type: "string" },
        company_name: { type: "string" },
        contact_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" }
      },
      required: ["service_type", "job_city", "job_state", "company_name", "contact_name", "email", "phone"]
    }
  }
];

// This executes tools when OpenAI requests them.
// Replace with real API calls (GHL, your DB, etc).

export async function runToolCall(name, args) {
  if (name === "create_intake_record") {
    // TODO: persist to GHL/DB
    // Keep it deterministic + idempotent in production.
    return {
      ok: true,
      message: "Intake captured.",
      captured: args
    };
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}
