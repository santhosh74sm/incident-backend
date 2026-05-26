/**
 * letterTemplateService.js
 * All business logic for letter template CRUD and file management.
 * Controllers must only call these functions — no FS/DB logic in controllers.
 */

'use strict';

const fs = require('fs');
const mongoose = require('mongoose');

const LetterTemplate = require('../models/LetterTemplate');
const Category = require('../models/Category');
const { createLog } = require('../utils/logger');
const logger = require('../utils/pinoLogger');
const s3StorageService = require('./s3StorageService');

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const resolveFileExists = (filePath) => !!(filePath && fs.existsSync(filePath));

const appendDocxAvailabilityFlags = (templateObj) => ({
    ...templateObj,
    hasEnglishDocx: !!(templateObj?.englishTemplateFile?.key || templateObj?.englishTemplateFile?.url || resolveFileExists(templateObj?.englishTemplateFile?.path)),
    hasTamilDocx: !!(templateObj?.tamilTemplateFile?.key || templateObj?.tamilTemplateFile?.url || resolveFileExists(templateObj?.tamilTemplateFile?.path)),
});

// ─────────────────────────────────────────────────────────────────────────────
// Read operations
// ─────────────────────────────────────────────────────────────────────────────

const getIncidentCategories = async () => {
    const categories = await Category.distinct('name');
    return categories.sort((a, b) => a.localeCompare(b));
};

const listLetterTemplates = async () => {
    const templates = await LetterTemplate.find({ isActive: true })
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .lean();
    return templates.map((t) => appendDocxAvailabilityFlags(t));
};

const getLetterTemplateById = async (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        const err = new Error('Invalid template ID');
        err.statusCode = 400;
        throw err;
    }

    const template = await LetterTemplate.findById(id).populate('createdBy', 'name').lean();
    if (!template) {
        const err = new Error('Template not found');
        err.statusCode = 404;
        throw err;
    }

    return appendDocxAvailabilityFlags(template);
};

const getTemplateByCategory = async (category) => {
    if (!category) {
        const err = new Error('Category parameter is required');
        err.statusCode = 400;
        throw err;
    }

    const decoded = decodeURIComponent(category).trim();
    const template = await LetterTemplate.findOne({
        incidentCategory: { $regex: new RegExp(`^${escapeRegex(decoded)}$`, 'i') },
        isActive: true,
    }).populate('createdBy', 'name').lean();

    if (!template) {
        return {
            exists: false,
            requestedCategory: decoded,
            hasEnglishDocx: false,
            hasTamilDocx: false,
            message: 'No Template Found for this Category',
        };
    }

    const hasEnglish = !!(template.englishTemplateFile?.key || template.englishTemplateFile?.url || resolveFileExists(template.englishTemplateFile?.path));
    const hasTamil = !!(template.tamilTemplateFile?.key || template.tamilTemplateFile?.url || resolveFileExists(template.tamilTemplateFile?.path));

    if (!hasEnglish && !hasTamil) {
        return {
            exists: true,
            requestedCategory: decoded,
            matchedCategory: template.incidentCategory,
            hasEnglishDocx: false,
            hasTamilDocx: false,
            message:
                'Template exists but no language files are available. Please upload at least one language version.',
        };
    }

    return {
        ...appendDocxAvailabilityFlags(template),
        exists: true,
        requestedCategory: decoded,
        matchedCategory: template.incidentCategory,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────────────────────────────────────────

const createLetterTemplate = async ({ title, incidentCategory, description }, userId) => {
    if (!title?.trim()) {
        const err = new Error('Template title is required');
        err.statusCode = 400;
        throw err;
    }
    if (!incidentCategory?.trim()) {
        const err = new Error('Incident category is required');
        err.statusCode = 400;
        throw err;
    }

    const existing = await LetterTemplate.findOne({ incidentCategory: incidentCategory.trim() });
    if (existing) {
        const err = new Error(
            'A template has already been created for this category. Please edit the existing one or choose a different category.'
        );
        err.statusCode = 400;
        throw err;
    }

    const template = new LetterTemplate({
        title: title.trim(),
        incidentCategory: incidentCategory.trim(),
        description: description || '',
        createdBy: userId,
        isActive: true,
    });

    await template.save();

    createLog('TEMPLATE_CREATED', userId, 'Template', template._id, {
        Title: template.title,
        Category: template.incidentCategory,
    });

    return template;
};

const updateLetterTemplate = async (id, { title, incidentCategory, description }, userId) => {
    const template = await LetterTemplate.findById(id);
    if (!template) {
        const err = new Error('Template not found');
        err.statusCode = 404;
        throw err;
    }

    if (!title?.trim()) {
        const err = new Error('Template title is required');
        err.statusCode = 400;
        throw err;
    }
    if (!incidentCategory?.trim()) {
        const err = new Error('Incident category is required');
        err.statusCode = 400;
        throw err;
    }

    if (template.incidentCategory !== incidentCategory.trim()) {
        const conflict = await LetterTemplate.findOne({
            incidentCategory: incidentCategory.trim(),
            _id: { $ne: id },
        });
        if (conflict) {
            const err = new Error(
                'A template has already been created for this category. Please edit the existing one or choose a different category.'
            );
            err.statusCode = 400;
            throw err;
        }
    }

    template.title = title.trim();
    template.incidentCategory = incidentCategory.trim();
    template.description = description || '';

    await template.save();

    createLog('TEMPLATE_UPDATED', userId, 'Template', template._id, { Title: template.title });

    return template;
};

const attachTemplateFile = async (templateId, language, uploadedFile, userId) => {
    if (!uploadedFile) {
        const err = new Error('No file uploaded. Please select a .docx file.');
        err.statusCode = 400;
        throw err;
    }

    if (language !== 'en' && language !== 'ta') {
        if (uploadedFile.key) {
            try { await s3StorageService.deleteObject(uploadedFile.key); } catch { /* Non-fatal */ }
        }
        if (uploadedFile.path && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
        const err = new Error('Invalid language specified. Use "en" or "ta".');
        err.statusCode = 400;
        throw err;
    }

    const template = await LetterTemplate.findById(templateId);
    if (!template) {
        if (uploadedFile.key) {
            try { await s3StorageService.deleteObject(uploadedFile.key); } catch { /* Non-fatal */ }
        }
        if (uploadedFile.path && fs.existsSync(uploadedFile.path)) fs.unlinkSync(uploadedFile.path);
        const err = new Error('Template not found');
        err.statusCode = 404;
        throw err;
    }

    const fileField = language === 'en' ? 'englishTemplateFile' : 'tamilTemplateFile';
    const hasFlagField = language === 'en' ? 'hasEnglishVersion' : 'hasTamilVersion';

    if (template[fileField]?.key) {
        try { await s3StorageService.deleteObject(template[fileField].key); } catch { /* Non-fatal */ }
    }
    if (template[fileField]?.path && fs.existsSync(template[fileField].path)) {
        try { fs.unlinkSync(template[fileField].path); } catch { /* Non-fatal */ }
    }

    const sanitizedTitle = template.title.replace(/[^a-zA-Z0-9.-]/g, '_');
    const newFilename = `${sanitizedTitle}_${language}.docx`;
    const uploadResult = uploadedFile.buffer
        ? await s3StorageService.uploadBuffer({
            buffer: uploadedFile.buffer,
            key: `letter-templates/${template._id}/${newFilename}`,
            filename: newFilename,
            contentType: uploadedFile.mimetype,
        })
        : {
            key: uploadedFile.key,
            url: uploadedFile.location,
        };

    template[fileField] = {
        filename: newFilename,
        originalName: uploadedFile.originalname,
        path: uploadResult.url,
        key: uploadResult.key,
        url: uploadResult.url,
        size: uploadedFile.size,
        mimeType: uploadedFile.mimetype,
    };
    template[hasFlagField] = true;

    await template.save();

    createLog('TEMPLATE_UPLOADED', userId, 'Template', template._id, {
        Title: template.title,
        Language: language,
        Filename: newFilename,
    });

    return appendDocxAvailabilityFlags(template.toObject());
};

const removeTemplateVariant = async (templateId, lang, userId) => {
    const template = await LetterTemplate.findById(templateId);
    if (!template) {
        const err = new Error('Template not found');
        err.statusCode = 404;
        throw err;
    }

    const fileField = lang === 'en' ? 'englishTemplateFile' : 'tamilTemplateFile';
    const hasFlagField = lang === 'en' ? 'hasEnglishVersion' : 'hasTamilVersion';

    if (template[fileField]?.key) {
        try { await s3StorageService.deleteObject(template[fileField].key); } catch { /* Non-fatal */ }
    }
    if (template[fileField]?.path && fs.existsSync(template[fileField].path)) {
        try { fs.unlinkSync(template[fileField].path); } catch { /* Non-fatal */ }
    }

    template[fileField] = undefined;
    template[hasFlagField] = false;

    await template.save();

    createLog('TEMPLATE_VARIANT_DELETED', userId, 'Template', template._id, {
        Title: template.title,
        Variant: lang,
    });

    return { message: 'Template variant removed' };
};

const deleteLetterTemplate = async (templateId, userId) => {
    const template = await LetterTemplate.findById(templateId);
    if (!template) {
        const err = new Error('Template not found');
        err.statusCode = 404;
        throw err;
    }

    for (const field of ['englishTemplateFile', 'tamilTemplateFile']) {
        if (template[field]?.key) {
            try { await s3StorageService.deleteObject(template[field].key); } catch { /* Non-fatal */ }
        }
        if (template[field]?.path && fs.existsSync(template[field].path)) {
            try { fs.unlinkSync(template[field].path); } catch { /* Non-fatal */ }
        }
    }

    await LetterTemplate.findByIdAndDelete(templateId);

    createLog('TEMPLATE_DELETED', userId, 'Template', template._id, {
        Title: template.title,
        Category: template.incidentCategory,
    });

    return { message: 'Template deleted successfully' };
};

// ─────────────────────────────────────────────────────────────────────────────
// Download operations
// ─────────────────────────────────────────────────────────────────────────────

const resolveTemplateDownloadPath = async (templateId, lang) => {
    const template = await LetterTemplate.findById(templateId);
    if (!template) {
        const err = new Error('Template not found');
        err.statusCode = 404;
        throw err;
    }

    const fileField = lang === 'en' ? 'englishTemplateFile' : 'tamilTemplateFile';
    if (!template[fileField]?.key && !template[fileField]?.path) {
        const err = new Error('No template file uploaded for this variant');
        err.statusCode = 404;
        throw err;
    }
    if (!template[fileField]?.key && !fs.existsSync(template[fileField].path)) {
        const err = new Error('Template file not found on server');
        err.statusCode = 404;
        throw err;
    }

    return {
        filePath: template[fileField].path,
        key: template[fileField].key,
        url: template[fileField].url || template[fileField].path,
        originalName: template[fileField].originalName || `${template.title}_${lang}.docx`,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// Smart tag reference guide
// ─────────────────────────────────────────────────────────────────────────────

const SMART_TAGS = [
    { tag: '{{studentName}}', description: 'Student Full Name' },
    { tag: '{{student_name}}', description: 'Student Full Name' },
    { tag: '[STUDENT_NAME]', description: 'Student Full Name' },
    { tag: '{{class}}', description: 'Student Class' },
    { tag: '[CLASS]', description: 'Student Class' },
    { tag: '{{section}}', description: 'Student Section' },
    { tag: '[SECTION]', description: 'Student Section' },
    { tag: '{{admissionNo}}', description: 'Admission Number' },
    { tag: '{{admission_no}}', description: 'Admission Number' },
    { tag: '[ADMISSION_NO]', description: 'Admission Number' },
    { tag: '{{date}}', description: 'Incident Date' },
    { tag: '[DATE]', description: 'Incident Date' },
    { tag: '{{incident_date}}', description: 'Incident Date' },
    { tag: '[INCIDENT_DATE]', description: 'Incident Date' },
    { tag: '{{currentDate}}', description: 'Current Date' },
    { tag: '[CURRENT_DATE]', description: 'Current Date' },
    { tag: '{{incidentTitle}}', description: 'Incident Title' },
    { tag: '{{incidentDescription}}', description: 'Incident Description' },
    { tag: '{{incident_description}}', description: 'Incident Description' },
    { tag: '[INCIDENT_DESCRIPTION]', description: 'Incident Description' },
    { tag: '{{location}}', description: 'Location' },
    { tag: '[LOCATION]', description: 'Location' },
    { tag: '{{year}}', description: 'Current Year' },
];

const getSmartTags = () => SMART_TAGS;

const buildReferenceGuideText = () => `SMART TAG REFERENCE GUIDE
=========================

Use DOUBLE braces {{ }} as shown below.

══════════════════════════════════════════════════════════════
STUDENT INFORMATION
══════════════════════════════════════════════════════════════
{{studentName}}     - Student's full name (e.g., John Doe)
{{admissionNo}}     - Admission/Registration number (e.g., 21295)
{{class}}           - Student's class/grade (e.g., 10)
{{section}}         - Student's section (e.g., A)

══════════════════════════════════════════════════════════════
INCIDENT DETAILS
══════════════════════════════════════════════════════════════
{{incidentTitle}}       - Title of the incident
{{incidentDescription}} - Full description of the incident
{{location}}            - Where the incident occurred
{{date}}                - Date of the incident (e.g., March 24, 2026)

══════════════════════════════════════════════════════════════
OTHER
══════════════════════════════════════════════════════════════
{{currentDate}} - Current date
{{year}}        - Current year (e.g., 2026)

══════════════════════════════════════════════════════════════
NOTES
══════════════════════════════════════════════════════════════
1. Tags are case-sensitive.
2. Use DOUBLE braces {{ }} exactly as shown.
3. Tags work in headers, footers, and body text.
4. Missing data will be replaced with an empty string.

GENERATED: ${new Date().toLocaleString()}
`;

module.exports = {
    getIncidentCategories,
    listLetterTemplates,
    getLetterTemplateById,
    getTemplateByCategory,
    createLetterTemplate,
    updateLetterTemplate,
    attachTemplateFile,
    removeTemplateVariant,
    deleteLetterTemplate,
    resolveTemplateDownloadPath,
    getSmartTags,
    buildReferenceGuideText,
};
