const { objectIdParamSchema, incidentIdParamSchema } = require('./commonValidators');

module.exports = {
    notificationIdParamSchema: objectIdParamSchema,
    notificationIncidentIdParamSchema: incidentIdParamSchema,
};
