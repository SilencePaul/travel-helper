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
