const normalizePositiveNumber = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return fallback;
    return parsed;
};

const getPagination = (query = {}, options = {}) => {
    const defaultPage = options.defaultPage || 1;
    const defaultLimit = options.defaultLimit || 10;
    const maxLimit = options.maxLimit || 50;

    const page = normalizePositiveNumber(query.page, defaultPage);
    const limit = Math.min(normalizePositiveNumber(query.limit, defaultLimit), maxLimit);
    const skip = (page - 1) * limit;

    return { page, limit, skip };
};

const buildPaginationMeta = ({ page, limit, total }) => {
    const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

    return {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
    };
};

module.exports = {
    normalizePositiveNumber,
    getPagination,
    buildPaginationMeta,
};
