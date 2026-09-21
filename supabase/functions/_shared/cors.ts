export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-vm-webhook-secret",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

/** RFC 9457 problem+json. */
export const problem = (status: number, title: string, detail?: string) =>
  new Response(JSON.stringify({ type: "about:blank", title, status, detail }), {
    status,
    headers: { ...cors, "Content-Type": "application/problem+json" },
  });
