const pick = (source = {}, allowedFields = []) =>
    allowedFields.reduce((acc, field) => {
        if (Object.prototype.hasOwnProperty.call(source, field)) {
            acc[field] = source[field];
        }
        return acc;
    }, {});

module.exports = pick;
