const AppError = require('./AppError');

const SCHOOL_ID_PATTERN = /^SCH-[A-Z0-9]+[0-9]{3}$/;

const normalizeSchoolId = (schoolId) => String(schoolId || '').trim().toUpperCase();

const getActorSchoolId = (actor) => normalizeSchoolId(actor?.schoolId);

const assertSchoolId = (schoolId) => {
    const normalized = normalizeSchoolId(schoolId);
    if (!normalized) {
        throw new AppError('School workspace context is required.', 401);
    }
    return normalized;
};

const tenantFilter = (actorOrSchoolId, extra = {}) => ({
    ...extra,
    schoolId: assertSchoolId(typeof actorOrSchoolId === 'string' ? actorOrSchoolId : getActorSchoolId(actorOrSchoolId)),
});

const tenantDoc = (actorOrSchoolId, doc = {}) => ({
    ...doc,
    schoolId: assertSchoolId(typeof actorOrSchoolId === 'string' ? actorOrSchoolId : getActorSchoolId(actorOrSchoolId)),
});

const sameTenant = (doc, actorOrSchoolId) =>
    normalizeSchoolId(doc?.schoolId) === assertSchoolId(typeof actorOrSchoolId === 'string' ? actorOrSchoolId : getActorSchoolId(actorOrSchoolId));

const assertSameTenant = (doc, actorOrSchoolId, message = 'Record not found in this school workspace.') => {
    if (!doc || !sameTenant(doc, actorOrSchoolId)) {
        throw new AppError(message, 404);
    }
};

const schoolScopedKey = (schoolId, folder, filename = '') => {
    const normalized = assertSchoolId(schoolId);
    const cleanFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
    const cleanFilename = String(filename || '').replace(/^\/+/g, '');
    return ['schools', normalized, cleanFolder, cleanFilename].filter(Boolean).join('/');
};

module.exports = {
    SCHOOL_ID_PATTERN,
    normalizeSchoolId,
    getActorSchoolId,
    assertSchoolId,
    tenantFilter,
    tenantDoc,
    sameTenant,
    assertSameTenant,
    schoolScopedKey,
};
