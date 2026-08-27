const { z } = require("zod");

const EventSchema = z.object({
  action: z.string().trim().min(1).optional(),
}).passthrough();

exports.main = async (event = {}) => {
  EventSchema.parse(event);
  return { error: "TRIP_API_NOT_IMPLEMENTED" };
};
