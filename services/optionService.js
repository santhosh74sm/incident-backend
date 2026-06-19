const Category = require('../models/Category');
const Location = require('../models/Location');
const EvidenceType = require('../models/EvidenceType');
const FieldOperationOption = require('../models/FieldOperationOption');
const Incident = require('../models/Incident');
const LetterTemplate = require('../models/LetterTemplate');
const { createLog } = require('../utils/logger');
const AppError = require('../utils/AppError');
const { tenantFilter, tenantDoc } = require('../utils/tenant');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getActorId = (actor) => actor?.id || actor?._id || 'System';
const UNKNOWN_FILTER_LABEL = 'Unknown';

const ensureOptionManager = (actor, message = 'Access Denied') => {
    if (!['Super Admin', 'Admin', 'Teacher', 'super_admin', 'admin', 'teacher'].includes(actor?.role)) {
        throw new AppError(message, 403);
    }
};

const findDuplicateByName = (Model, name, actor, excludeId = null) => {
    const query = tenantFilter(actor, { name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') } });
    if (excludeId) query._id = { $ne: excludeId };
    return Model.findOne(query).select('_id').lean();
};

const getCategories = async (actor) => Category.find(tenantFilter(actor)).sort({ name: 1 }).lean();

const addCategory = async ({ input, actor }) => {
    ensureOptionManager(actor);

    const trimmedName = String(input.name || '').trim();
    if (!trimmedName) throw new AppError('Category name is required', 400);

    const exists = await findDuplicateByName(Category, trimmedName, actor);
    if (exists) throw new AppError('This type already exists', 400);

    const category = await Category.create(tenantDoc(actor, { name: trimmedName }));

    createLog('Add', getActorId(actor), 'Category', category._id, {
        targetLabel: category.name,
        details: `New Incident Type added: ${category.name}`,
    });

    return category;
};

const updateCategory = async ({ id, input, actor }) => {
    ensureOptionManager(actor);

    const nextName = String(input.name || '').trim();
    if (!nextName) throw new AppError('Category name is required', 400);

    const category = await Category.findOne(tenantFilter(actor, { _id: id }));
    if (!category) throw new AppError('Category not found', 404);

    const duplicate = await findDuplicateByName(Category, nextName, actor, category._id);
    if (duplicate) throw new AppError('This type already exists', 400);

    const previousName = category.name;
    category.name = nextName;
    await category.save();

    await Promise.all([
        Incident.updateMany(tenantFilter(actor, { category: previousName }), { $set: { category: nextName } }),
        LetterTemplate.updateMany(tenantFilter(actor, { incidentCategory: previousName }), { $set: { incidentCategory: nextName } }),
    ]);

    createLog('Edit', getActorId(actor), 'Category', category._id, {
        targetLabel: nextName,
        previousName,
        newName: nextName,
        details: `Incident Type renamed: ${previousName} -> ${nextName}`,
    });

    return category;
};

const deleteCategory = async ({ id, actor }) => {
    ensureOptionManager(actor);

    const category = await Category.findOne(tenantFilter(actor, { _id: id }));
    if (!category) throw new AppError('Category not found', 404);

    await Category.findOneAndDelete(tenantFilter(actor, { _id: id }));

    createLog('Remove', getActorId(actor), 'Category', category._id, {
        targetLabel: category.name,
        details: `Incident Type deleted: ${category.name}`,
    });

    return { message: 'Category deleted successfully.' };
};

const getLocations = async (actor, { includeUnknown = false } = {}) => {
    const locations = await Location.find(tenantFilter(actor)).sort({ name: 1 }).lean();
    if (!includeUnknown) return locations;

    const hasUnknownLocationRecords = await Incident.exists(tenantFilter(actor, {
        $or: [
            { location: { $exists: false } },
            { location: null },
            { location: { $regex: /^\s*$/ } },
        ],
    }));

    const alreadyHasUnknown = locations.some(
        (location) => String(location?.name || '').trim().toLowerCase() === UNKNOWN_FILTER_LABEL.toLowerCase()
    );

    if (!hasUnknownLocationRecords || alreadyHasUnknown) return locations;
    return [...locations, { id: UNKNOWN_FILTER_LABEL, name: UNKNOWN_FILTER_LABEL, virtual: true }];
};

const addLocation = async ({ input, actor }) => {
    ensureOptionManager(actor);

    const trimmedName = String(input.name || '').trim();
    if (!trimmedName) throw new AppError('Zone name is required', 400);

    const exists = await findDuplicateByName(Location, trimmedName, actor);
    if (exists) throw new AppError('This zone already exists', 400);

    const location = await Location.create(tenantDoc(actor, { name: trimmedName }));

    createLog('Add', getActorId(actor), 'Location', location._id, {
        targetLabel: location.name,
        details: `New Location Zone added: ${location.name}`,
    });

    return location;
};

const updateLocation = async ({ id, input, actor }) => {
    ensureOptionManager(actor);

    const nextName = String(input.name || '').trim();
    if (!nextName) throw new AppError('Zone name is required', 400);

    const location = await Location.findOne(tenantFilter(actor, { _id: id }));
    if (!location) throw new AppError('Location not found', 404);

    const duplicate = await findDuplicateByName(Location, nextName, actor, location._id);
    if (duplicate) throw new AppError('This zone already exists', 400);

    const previousName = location.name;
    location.name = nextName;
    await location.save();

    await Incident.updateMany(tenantFilter(actor, { location: previousName }), { $set: { location: nextName } });

    createLog('Edit', getActorId(actor), 'Location', location._id, {
        targetLabel: nextName,
        previousName,
        newName: nextName,
        details: `Location Zone renamed: ${previousName} -> ${nextName}`,
    });

    return location;
};

const deleteLocation = async ({ id, actor }) => {
    ensureOptionManager(actor);

    const location = await Location.findOne(tenantFilter(actor, { _id: id }));
    if (!location) throw new AppError('Location not found', 404);

    await Location.findOneAndDelete(tenantFilter(actor, { _id: id }));

    createLog('Remove', getActorId(actor), 'Location', location._id, {
        targetLabel: location.name,
        details: `Location Zone deleted: ${location.name}`,
    });

    return { message: 'Location deleted successfully.' };
};

const getEvidenceTypes = async (actor, { includeUnknown = false } = {}) => {
    const evidenceTypes = await EvidenceType.find(tenantFilter(actor)).sort({ name: 1 }).lean();
    if (!includeUnknown) return evidenceTypes;

    const hasUnknownEvidenceRecords = await Incident.exists(tenantFilter(actor, {
        $or: [
            { evidence: { $exists: false } },
            { evidence: { $size: 0 } },
            { 'evidence.evidenceType': { $exists: false } },
            { 'evidence.evidenceType': null },
            { 'evidence.evidenceType': { $regex: /^\s*$/ } },
        ],
    }));

    const alreadyHasUnknown = evidenceTypes.some(
        (evidenceType) => String(evidenceType?.name || '').trim().toLowerCase() === UNKNOWN_FILTER_LABEL.toLowerCase()
    );

    if (!hasUnknownEvidenceRecords || alreadyHasUnknown) return evidenceTypes;
    return [...evidenceTypes, { id: UNKNOWN_FILTER_LABEL, name: UNKNOWN_FILTER_LABEL, virtual: true }];
};

const addEvidenceType = async ({ input, actor }) => {
    ensureOptionManager(actor, 'Admin or Teacher access required');

    const nextName = String(input.name || '').trim();
    if (!nextName) throw new AppError('Evidence type name is required', 400);

    const existing = await findDuplicateByName(EvidenceType, nextName, actor);
    if (existing) throw new AppError('Evidence type already exists', 400);

    const evidenceType = await EvidenceType.create(tenantDoc(actor, {
        name: nextName,
        description: input.description?.trim() || '',
        createdBy: getActorId(actor),
    }));

    createLog('Add', getActorId(actor), 'EvidenceType', evidenceType._id, {
        targetLabel: evidenceType.name,
        details: `Evidence type added: ${evidenceType.name}`,
    });

    return evidenceType;
};

const updateEvidenceType = async ({ id, input, actor }) => {
    ensureOptionManager(actor, 'Admin or Teacher access required');

    const nextName = String(input.name || '').trim();
    if (!nextName) throw new AppError('Evidence type name is required', 400);

    const evidenceType = await EvidenceType.findOne(tenantFilter(actor, { _id: id }));
    if (!evidenceType) throw new AppError('Evidence type not found', 404);

    const existing = await findDuplicateByName(EvidenceType, nextName, actor, evidenceType._id);
    if (existing) throw new AppError('Evidence type already exists', 400);

    const previousName = evidenceType.name;
    evidenceType.name = nextName;
    if (input.description !== undefined) {
        evidenceType.description = input.description?.trim() || '';
    }

    await evidenceType.save();

    await Incident.updateMany(
        tenantFilter(actor, { 'evidence.evidenceType': previousName }),
        { $set: { 'evidence.$[entry].evidenceType': nextName } },
        { arrayFilters: [{ 'entry.evidenceType': previousName }] }
    );

    createLog('Edit', getActorId(actor), 'EvidenceType', evidenceType._id, {
        targetLabel: nextName,
        previousName,
        newName: nextName,
        details: `Evidence type renamed: ${previousName} -> ${nextName}`,
    });

    return evidenceType;
};

const deleteEvidenceType = async ({ id, actor }) => {
    ensureOptionManager(actor, 'Admin or Teacher access required');

    const evidenceType = await EvidenceType.findOne(tenantFilter(actor, { _id: id }));
    if (!evidenceType) throw new AppError('Evidence type not found', 404);

    await EvidenceType.findOneAndDelete(tenantFilter(actor, { _id: id }));

    createLog('Remove', getActorId(actor), 'EvidenceType', evidenceType._id, {
        targetLabel: evidenceType.name,
        details: `Evidence type deleted: ${evidenceType.name}`,
    });

    return { message: 'Evidence type deleted successfully.' };
};

const getFieldOperationOptions = async (type, actor) => {
    if (!type || !['handler', 'assigner'].includes(type)) {
        throw new AppError('Valid type (handler/assigner) is required', 400);
    }

    return FieldOperationOption.find(tenantFilter(actor, { type })).sort({ order: 1 }).lean();
};

const addFieldOperationOption = async ({ input, actor }) => {
    if (!input.type || !['handler', 'assigner'].includes(input.type)) {
        throw new AppError('Valid type is required', 400);
    }

    const label = String(input.label || '').trim();
    if (!label) throw new AppError('Label is required', 400);

    const maxOrder = await FieldOperationOption.findOne(tenantFilter(actor, { type: input.type })).sort({ order: -1 }).select('order').lean();
    const option = await FieldOperationOption.create(tenantDoc(actor, {
        label,
        type: input.type,
        order: maxOrder ? maxOrder.order + 1 : 1,
        isDefault: false,
    }));

    return option;
};

const deleteFieldOperationOption = async (id, actor) => {
    const option = await FieldOperationOption.findOne(tenantFilter(actor, { _id: id }));
    if (!option) throw new AppError('Option not found', 404);

    await FieldOperationOption.findOneAndDelete(tenantFilter(actor, { _id: id }));
    return { message: 'Option deleted successfully.' };
};

const reorderFieldOperationOptions = async (options, actor) => {
    if (!Array.isArray(options)) {
        throw new AppError('Options array is required', 400);
    }

    const bulkOps = options.map((item, index) => ({
        updateOne: {
            filter: tenantFilter(actor, { _id: item._id || item.id }),
            update: { order: index },
        },
    }));

    await FieldOperationOption.bulkWrite(bulkOps);

    const type = options[0]?.type;
    return FieldOperationOption.find(tenantFilter(actor, { type })).sort({ order: 1 }).lean();
};

module.exports = {
    getCategories,
    addCategory,
    updateCategory,
    deleteCategory,
    getLocations,
    addLocation,
    updateLocation,
    deleteLocation,
    getEvidenceTypes,
    addEvidenceType,
    updateEvidenceType,
    deleteEvidenceType,
    getFieldOperationOptions,
    addFieldOperationOption,
    deleteFieldOperationOption,
    reorderFieldOperationOptions,
};
