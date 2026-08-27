const { z } = require("zod");

const HttpEventSchema = z.object({
  path: z.string().optional(),
}).passthrough();

exports.main = async (event = {}) => {
  HttpEventSchema.parse(event);

  return {
    statusCode: 501,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: "AUTH_SERVICE_NOT_IMPLEMENTED" }),
  };
};

if (require.main === module) {
  const http = require("node:http");
  const port = Number(process.env.PORT || 9000);

  http.createServer(async (request, response) => {
    const result = await exports.main({ path: request.url });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  }).listen(port, "0.0.0.0");
}
