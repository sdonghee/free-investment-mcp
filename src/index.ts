export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return new Response(
        JSON.stringify({
          name: "free-investment-mcp",
          status: "online",
          message: "MCP endpoint bootstrap is running"
        }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8"
          }
        }
      );
    }

    return new Response("free-investment-mcp is running");
  }
};
