const { z } = require('zod');

const filenameParamSchema = z.object({
    filename: z.coerce.string().trim().min(1).max(500),
});

module.exports = { filenameParamSchema };
