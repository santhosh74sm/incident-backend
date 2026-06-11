/**
 * issuedLetterService.js
 * All business logic for issued letter generation, listing, filtering, and downloads.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const IssuedLetter = require('../models/IssuedLetter');
const LetterTemplate = require('../models/LetterTemplate');
const Incident = require('../models/Incident');
const Student = require('../models/Student');

const { createLog } = require('../utils/logger');
const { getPagination, buildPaginationMeta } = require('../utils/pagination');
const { letterQueue } = require('../utils/asyncQueue');
const logger = require('../utils/pinoLogger');
const s3StorageService = require('./s3StorageService');
const { deleteS3ObjectOrThrow } = require('./s3CleanupService');
const { escapeXmlText, validateDocxBuffer } = require('../utils/docxSecurity');
const { tenantFilter, schoolScopedKey } = require('../utils/tenant');

const ADMIN_ROLES = new Set(['Super Admin', 'Admin', 'super_admin', 'admin']);
const OPERATIONAL_ROLES = new Set(['Teacher', 'teacher']);
const LETTER_RESPONSE_EXCLUDE = '-generatedDocx';
const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toIdString = (value) => {
    if (!value) return '';
    if (value._id) return String(value._id);
    return String(value);
};

const stripGeneratedDocx = (letter) => {
    if (!letter) return letter;
    const value = typeof letter.toObject === 'function' ? letter.toObject() : { ...letter };
    delete value.generatedDocx;
    return value;
};

const canAccessIncident = (incident, user) => {
    if (!incident || !user) return false;
    if (String(incident.schoolId || '').toUpperCase() !== String(user.schoolId || '').toUpperCase()) return false;
    if (ADMIN_ROLES.has(user.role)) return true;

    const userId = toIdString(user.id || user._id);
    if (OPERATIONAL_ROLES.has(user.role)) {
        return [incident.reportedBy, incident.assignedHandler].some((id) => toIdString(id) === userId);
    }

    if (user.role === 'Student') {
        return String(incident.admissionNo || '') === String(user.admissionNo || '');
    }

    return false;
};

const assertIncidentLetterAccess = async (incidentId, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }))
        .select('reportedBy assignedHandler admissionNo')
        .lean();

    if (!incident) {
        const err = new Error('Incident not found');
        err.statusCode = 404;
        throw err;
    }

    if (!canAccessIncident(incident, user)) {
        const err = new Error('You are not allowed to access letters for this incident.');
        err.statusCode = 403;
        throw err;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// XML / DOCX processing helpers
// ─────────────────────────────────────────────────────────────────────────────

const buildPlaceholderData = (data) => {
    const value = (key) => data[key] ?? '';

    return {
        ...data,
        student_name: value('studentName'),
        STUDENT_NAME: value('studentName'),
        admission_no: value('admissionNo'),
        admission_number: value('admissionNo'),
        ADMISSION_NO: value('admissionNo'),
        ADMISSION_NUMBER: value('admissionNo'),
        className: value('class'),
        class_name: value('class'),
        CLASS: value('class'),
        section: value('section'),
        SECTION: value('section'),
        date: value('date'),
        DATE: value('date'),
        incidentDate: value('date'),
        incident_date: value('date'),
        INCIDENT_DATE: value('date'),
        current_date: value('currentDate'),
        CURRENT_DATE: value('currentDate'),
        year: value('year'),
        YEAR: value('year'),
        incident_category: value('incidentCategory'),
        INCIDENT_CATEGORY: value('incidentCategory'),
        incident_title: value('incidentTitle'),
        INCIDENT_TITLE: value('incidentTitle'),
        incident_description: value('incidentDescription'),
        description: value('incidentDescription'),
        INCIDENT_DESCRIPTION: value('incidentDescription'),
        DESCRIPTION: value('incidentDescription'),
        location: value('location'),
        LOCATION: value('location'),
        school_name: value('schoolName'),
        SCHOOL_NAME: value('schoolName'),
        principal_name: value('principalName'),
        PRINCIPAL_NAME: value('principalName'),
    };
};

const replaceBracketPlaceholders = (xmlContent, data) => {
    let result = xmlContent;
    const bracketKeys = Object.keys(data).filter((key) => /^[A-Za-z0-9_]+$/.test(key));

    for (const key of bracketKeys) {
        const pattern = new RegExp(`\\[${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'g');
        result = result.replace(pattern, escapeXmlText(data[key]));
    }

    return result;
};

const fixXmlFragments = (xmlContent) => {
    let result = xmlContent;
    const tagMatches = [...xmlContent.matchAll(/\{\{([^}]+)\}\}/g)];

    for (const match of tagMatches) {
        const fullTag = match[0];
        const tagName = match[1];
        const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
            new RegExp(`</w:t>\\s*<w:t[^>]*>\\s*${escapedTag}\\s*</w:t>\\s*<w:t[^>]*>\\s*}\\s*</w:t>`, 'gi'),
            new RegExp(`<w:t[^>]*>\\s*\\{\\{\\s*</w:t>\\s*<w:t[^>]*>\\s*${escapedTag}\\s*</w:t>\\s*<w:t[^>]*>\\s*}\\s*</w:t>`, 'gi'),
            new RegExp(`<w:t[^>]*>\\s*\\{\\{\\s*</w:t>\\s*<w:t[^>]*>\\s*${escapedTag}\\s*</w:t>\\s*<w:t[^>]*>\\s*\\}\\s*</w:t>`, 'gi'),
        ];
        patterns.forEach((pattern) => { result = result.replace(pattern, fullTag); });
    }

    return result;
};

const prepareDocxForDocxtemplater = (originalZip, placeholderData = {}) => {
    const PizZip = require('pizzip');
    const newZip = new PizZip();

    for (const filename of Object.keys(originalZip.files)) {
        const file = originalZip.files[filename];
        if (!file.dir && filename.startsWith('word/') && filename.endsWith('.xml')) {
            const content = file.asText();
            const fixedContent = replaceBracketPlaceholders(fixXmlFragments(content), placeholderData);
            newZip.file(filename, fixedContent);
        } else if (!file.dir) {
            newZip.file(filename, file.asNodeBuffer());
        } else {
            newZip.folder(filename);
        }
    }

    return newZip;
};

const resolveTemplatePath = (templatePath) => {
    if (!templatePath) return null;
    if (fs.existsSync(templatePath)) return templatePath;
    const backendPath = path.join(__dirname, '..', templatePath);
    if (fs.existsSync(backendPath)) return backendPath;
    return null;
};

const hasTemplateFile = (templateFile) =>
    !!(templateFile?.key || templateFile?.url || resolveTemplatePath(templateFile?.path));

const getTemplateBuffer = async (templateFile) => {
    if (templateFile?.key) {
        const buffer = await s3StorageService.getBuffer(templateFile.key);
        validateDocxBuffer(buffer);
        return buffer;
    }

    const templatePath = resolveTemplatePath(templateFile?.path);
    if (!templatePath) return null;
    const buffer = fs.readFileSync(templatePath);
    validateDocxBuffer(buffer);
    return buffer;
};

const formatLetterDate = (value) => {
    const date = value ? new Date(value) : new Date();
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    return safeDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
};

const buildIncidentLetterData = async (incident) => {
    const incidentDate =
        incident.incidentDate ||
        incident.openedAt ||
        incident.submittedAt ||
        incident.createdAt ||
        incident.date;

    const studentData = {
        studentName: incident.studentsInvolved?.[0] || 'Student',
        class: incident.class || '',
        section: incident.section || '',
        admissionNo: incident.admissionNo || '',
        date: formatLetterDate(incidentDate),
        currentDate: formatLetterDate(new Date()),
        year: new Date().getFullYear().toString(),
        incidentCategory: incident.incidentCategory || incident.category || '',
        incidentTitle: incident.title || '',
        incidentDescription: incident.description || '',
        location: incident.location || '',
        schoolName: process.env.SCHOOL_NAME || 'Your School Name',
        principalName: process.env.PRINCIPAL_NAME || 'Principal',
    };

    if (incident.admissionNo) {
        const student = await Student.findOne({ schoolId: incident.schoolId, admissionNo: incident.admissionNo }).lean();
        if (student) {
            studentData.studentName = student.name || studentData.studentName;
            studentData.class = student.className || studentData.class;
            studentData.section = student.section || studentData.section;
        }
    }

    return buildPlaceholderData(studentData);
};

const renderDocxTemplate = (fileBuffer, studentData) => {
    const PizZip = require('pizzip');
    const Docxtemplater = require('docxtemplater');
    const preparedZip = prepareDocxForDocxtemplater(validateDocxBuffer(fileBuffer), studentData);
    const doc = new Docxtemplater(preparedZip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: { start: '{{', end: '}}' },
        nullGetter: () => '',
    });
    doc.render(studentData);
    return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
};

// ─────────────────────────────────────────────────────────────────────────────
// Letter generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-generate an issued letter from an incident using a matching DOCX template.
 * Returns { success, letter } on success or { success: false, message } on failure.
 */
const autoGenerateLetterFromIncident = async (incident, userId, language = 'en', skipLog = false) => {
    try {
        const incidentCategory = (incident.incidentCategory || incident.category)?.trim();
        if (!incidentCategory) {
            return { success: false, message: 'No category specified for incident' };
        }

        const matchingTemplate = await LetterTemplate.findOne({
            schoolId: incident.schoolId,
            isActive: true,
            incidentCategory: { $regex: new RegExp(`^${escapeRegex(incidentCategory)}$`, 'i') },
        }).lean();

        const templateAvailable = language === 'ta'
            ? hasTemplateFile(matchingTemplate?.tamilTemplateFile)
            : hasTemplateFile(matchingTemplate?.englishTemplateFile);

        if (!matchingTemplate || !templateAvailable) {
            return {
                success: false,
                message: `No matching template found for category "${incidentCategory}"`,
                categoryMatched: false,
            };
        }

        const templateFile =
            language === 'ta'
                ? matchingTemplate.tamilTemplateFile
                : matchingTemplate.englishTemplateFile;
        const templateBuffer = await getTemplateBuffer(templateFile);
        if (!templateBuffer) {
            return { success: false, message: 'Template file not found' };
        }

        const studentData = await buildIncidentLetterData(incident);
        let outputBuffer;

        try {
            outputBuffer = renderDocxTemplate(templateBuffer, studentData);
        } catch (docxErr) {
            logger.error('Letter generation failed (docxtemplater)', {
                error: docxErr?.message,
                incidentId: incident._id,
            });
            return {
                success: false,
                message: 'Failed to process template. The .docx file may be corrupted.',
            };
        }

        const letterNumber = await IssuedLetter.generateLetterNumber(incident.schoolId);
        const issuedLetter = new IssuedLetter({
            schoolId: incident.schoolId,
            letterNumber,
            incident: incident._id,
            studentName: studentData.studentName,
            admissionNo: studentData.admissionNo,
            className: studentData.class,
            section: studentData.section,
            incidentCategory: incident.category,
            templateId: matchingTemplate._id,
            title: matchingTemplate.title,
            generatedDocx: outputBuffer,
            generatedDocxKey: '',
            generatedDocxUrl: '',
            issuedBy: userId,
            status: 'Issued',
            language,
        });

        await issuedLetter.save();

        if (!skipLog) {
            try {
                createLog(
                    `LETTER_GENERATED: ${matchingTemplate.title}`,
                    userId.toString(),
                    'Letter',
                    issuedLetter._id,
                    {
                        studentName: studentData.studentName,
                        templateName: matchingTemplate.title,
                        format: 'DOCX',
                        incidentId: incident._id,
                        letterNumber,
                    }
                );
            } catch {
                // Non-critical: letter was saved; log failure is acceptable.
            }
        }

        return { success: true, letter: issuedLetter };
    } catch (err) {
        logger.error('Letter generation exception', { error: err?.message, incidentId: incident?._id });
        return { success: false, message: err.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Query / filter helpers
// ─────────────────────────────────────────────────────────────────────────────

const parseListQueryParam = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value !== 'string') return [];
    return value.split(',').map((v) => v.trim()).filter(Boolean);
};

const parseAliasedListQueryParam = (query, keys = []) =>
    [...new Set(keys.flatMap((key) => parseListQueryParam(query?.[key])))];

const LETTER_STATUS_LOOKUP = {
    issued: 'Issued',
    printed: 'Printed',
    sent: 'Sent',
    'successfully issued': 'Successfully Issued',
};

const normalizeLetterStatuses = (values = []) =>
    values
        .map((v) => LETTER_STATUS_LOOKUP[String(v || '').trim().toLowerCase()] || String(v || '').trim())
        .filter(Boolean);

const parseLocalCalendarDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    const normalized = String(value).trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseDateBoundary = (value, boundary) => {
    const parsed = parseLocalCalendarDate(value);
    if (!parsed) return null;
    if (boundary === 'end') { parsed.setHours(23, 59, 59, 999); return parsed; }
    parsed.setHours(0, 0, 0, 0);
    return parsed;
};

const buildIncidentTimelineDateQuery = (startDateValue, endDateValue) => {
    if (!startDateValue && !endDateValue) return null;
    const dateQuery = {};
    const startDate = parseDateBoundary(startDateValue, 'start');
    if (startDate) dateQuery.$gte = startDate;
    const endDate = parseDateBoundary(endDateValue, 'end');
    if (endDate) dateQuery.$lte = endDate;
    if (Object.keys(dateQuery).length === 0) return null;
    return { $or: [{ incidentDate: dateQuery }, { incident_date: dateQuery }] };
};

const buildLetterQuery = async (query) => {
    const builtQuery = { schoolId: query.schoolId };

    const studentName = String(query.studentName || query.student || '').trim();
    if (studentName) {
        const safe = studentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        builtQuery.studentName = { $regex: safe, $options: 'i' };
    }

    const admissionNo = String(query.admissionNo || query.admissionNumber || '').trim();
    if (admissionNo) {
        const safe = admissionNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        builtQuery.admissionNo = { $regex: safe, $options: 'i' };
    }

    const classes = parseAliasedListQueryParam(query, ['className', 'class', 'classes']);
    if (classes.length > 0) builtQuery.className = { $in: classes };

    const sections = parseAliasedListQueryParam(query, ['section', 'sections']);
    if (sections.length > 0) builtQuery.section = { $in: sections };

    const categories = parseAliasedListQueryParam(query, ['incidentCategory', 'category', 'categories']);
    if (categories.length === 1) {
        const safe = categories[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        builtQuery.incidentCategory = { $regex: safe, $options: 'i' };
    }
    else if (categories.length > 1) builtQuery.incidentCategory = { $in: categories };

    const statuses = normalizeLetterStatuses(
        parseAliasedListQueryParam(query, ['status', 'statuses'])
    );
    if (statuses.length === 1) builtQuery.status = statuses[0];
    else if (statuses.length > 1) builtQuery.status = { $in: statuses };

    const incidentDateQuery = buildIncidentTimelineDateQuery(
        query.fromDate || query.startDate,
        query.toDate || query.endDate
    );
    if (incidentDateQuery) {
        const matchingIncidentIds = await Incident.find({ ...incidentDateQuery, schoolId: query.schoolId }).distinct('_id');
        builtQuery.incident = { $in: matchingIncidentIds };
    }

    return builtQuery;
};

// ─────────────────────────────────────────────────────────────────────────────
// CRUD operations
// ─────────────────────────────────────────────────────────────────────────────

const listIssuedLetters = async (query, user) => {
    const builtQuery = await buildLetterQuery({ ...query, schoolId: user.schoolId });
    const shouldPaginate = query.page !== undefined || query.limit !== undefined;
    const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });

    let letterQuery = IssuedLetter.find(builtQuery)
        .select(LETTER_RESPONSE_EXCLUDE)
        .populate('issuedBy', 'name')
        .populate(
            'incident',
            'title description category status location incidentDate openedAt createdAt submittedAt'
        )
        .sort({ generatedAt: -1 });

    if (shouldPaginate) {
        letterQuery = letterQuery.skip(pagination.skip).limit(pagination.limit);
    }

    const [data, total] = await Promise.all([
        letterQuery.lean(),
        shouldPaginate ? IssuedLetter.countDocuments(builtQuery) : Promise.resolve(null),
    ]);

    if (shouldPaginate) {
        return {
            paginated: true,
            data,
            pagination: buildPaginationMeta({ page: pagination.page, limit: pagination.limit, total }),
        };
    }

    return { paginated: false, data };
};

const getIssuedLetterById = async (id, user) => {
    const letter = await IssuedLetter.findOne(tenantFilter(user, { _id: id }))
        .select(LETTER_RESPONSE_EXCLUDE)
        .populate('issuedBy', 'name role')
        .populate('incident', 'title description category status location severity')
        .lean();
    if (!letter) {
        const err = new Error('Letter not found');
        err.statusCode = 404;
        throw err;
    }
    return letter;
};

const getLettersByIncident = async (incidentId, user) => {
    await assertIncidentLetterAccess(incidentId, user);
    return IssuedLetter.find(tenantFilter(user, { incident: incidentId }))
        .select(LETTER_RESPONSE_EXCLUDE)
        .populate('issuedBy', 'name')
        .populate(
            'incident',
            'title description category status location incidentDate openedAt createdAt submittedAt'
        )
        .sort({ generatedAt: -1 })
        .lean();
};

const getLettersByStudent = async (admissionNo, query, user) => {
    if (!ADMIN_ROLES.has(user?.role) && !(user?.role === 'Student' && String(user.admissionNo || '') === String(admissionNo || ''))) {
        const err = new Error('You are not allowed to access letters for this student.');
        err.statusCode = 403;
        throw err;
    }

    const letterQuery = { admissionNo };
    const incidentDateQuery = buildIncidentTimelineDateQuery(
        query.fromDate || query.startDate,
        query.toDate || query.endDate
    );
    if (incidentDateQuery) {
        const matchingIncidentIds = await Incident.find({ ...incidentDateQuery, schoolId: user.schoolId }).distinct('_id');
        letterQuery.incident = { $in: matchingIncidentIds };
    }
    return IssuedLetter.find(tenantFilter(user, letterQuery))
        .select(LETTER_RESPONSE_EXCLUDE)
        .populate('issuedBy', 'name')
        .populate(
            'incident',
            'title description category status location incidentDate openedAt createdAt submittedAt'
        )
        .sort({ generatedAt: -1 })
        .lean();
};

const getLetterStatusByIncidentIds = async (incidentIds, user) => {
    if (!Array.isArray(incidentIds) || incidentIds.length === 0) return {};

    let allowedIncidentIds = incidentIds;
    if (!ADMIN_ROLES.has(user?.role)) {
        const incidents = await Incident.find(tenantFilter(user, { _id: { $in: incidentIds } }))
            .select('reportedBy assignedHandler admissionNo')
            .lean();
        allowedIncidentIds = incidents
            .filter((incident) => canAccessIncident(incident, user))
            .map((incident) => incident._id);
    }

    if (allowedIncidentIds.length === 0) return {};

    const letters = await IssuedLetter.find(tenantFilter(user, { incident: { $in: allowedIncidentIds } })).select(
        'incident letterNumber generatedAt'
    ).lean();
    const statusMap = {};
    letters.forEach((letter) => {
        statusMap[letter.incident.toString()] = {
            hasLetter: true,
            letterNumber: letter.letterNumber,
            generatedAt: letter.generatedAt,
        };
    });
    return statusMap;
};

const generateLetterFromIncident = async (incidentId, language, user) => {
    const incident = await Incident.findOne(tenantFilter(user, { _id: incidentId }));
    if (!incident) {
        const err = new Error('Incident not found.');
        err.statusCode = 404;
        throw err;
    }

    const existing = await IssuedLetter.findOne(tenantFilter(user, { incident: incident._id, language }));
    if (existing) {
        return { alreadyExists: true, letter: stripGeneratedDocx(existing) };
    }

    // Offload DOCX rendering to letterQueue (non-blocking)
    const result = await letterQueue.push(
        () => autoGenerateLetterFromIncident(incident, user.id || user._id, language)
    ).promise;

    if (!result.success) {
        const err = new Error(result.message || 'Letter generation failed.');
        err.statusCode = 400;
        throw err;
    }

    return { alreadyExists: false, letter: stripGeneratedDocx(result.letter) };
};

const updateIssuedLetter = async (id, body, user) => {
    const letter = await IssuedLetter.findOne(tenantFilter(user, { _id: id }));
    if (!letter) {
        const err = new Error('Letter not found');
        err.statusCode = 404;
        throw err;
    }

    const allowedUpdates = ['status', 'notes'];
    allowedUpdates.forEach((field) => {
        if (body[field] !== undefined) letter[field] = body[field];
    });

    if (body.status === 'Printed' && letter.status !== 'Printed') {
        letter.printedAt = new Date();
    }

    await letter.save();

    createLog('Letter Updated', user.id || user._id, 'Letter', letter._id, {
        status: letter.status,
        letterNumber: letter.letterNumber,
        incidentId: letter.incident,
    });

    return stripGeneratedDocx(letter);
};

const deleteIssuedLetter = async (id, user) => {
    const actorId = user?.id || user?._id || user;
    const schoolId = user?.schoolId;
    const letter = schoolId
        ? await IssuedLetter.findOne(tenantFilter(user, { _id: id }))
        : await IssuedLetter.findById(id);
    if (!letter) {
        const err = new Error('Letter not found');
        err.statusCode = 404;
        throw err;
    }

    if (letter.generatedDocxKey) {
        await deleteS3ObjectOrThrow(letter.generatedDocxKey, {
            operation: 'deleteIssuedLetter',
            letterId: id,
            letterNumber: letter.letterNumber,
            actorId,
        });
    }

    if (schoolId) await IssuedLetter.findOneAndDelete(tenantFilter(user, { _id: id }));
    else await IssuedLetter.findByIdAndDelete(id);

    createLog('Letter Deleted', actorId, 'Letter', letter._id, {
        letterNumber: letter.letterNumber,
        studentName: letter.studentName,
        incidentId: letter.incident,
    });

    return { message: 'Letter deleted successfully' };
};

const getLetterFilterOptions = async (user) => {
    const [classes, sections, categories] = await Promise.all([
        IssuedLetter.distinct('className', tenantFilter(user)),
        IssuedLetter.distinct('section', tenantFilter(user)),
        IssuedLetter.distinct('incidentCategory', tenantFilter(user)),
    ]);

    return {
        classes: classes.filter(Boolean).sort((a, b) => {
            const aNum = parseInt(a);
            const bNum = parseInt(b);
            if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
            return a.localeCompare(b);
        }),
        sections: sections.filter(Boolean).sort(),
        categories: categories.filter(Boolean).sort(),
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// Download helpers
// ─────────────────────────────────────────────────────────────────────────────

const slugify = (str) => {
    if (!str) return '';
    return str
        .toString()
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .substring(0, 50);
};

const generateLetterFilename = (letter, extension) => {
    const title = slugify(letter.title || 'Incident_Letter');
    const className = slugify(letter.className || 'Class');
    const section = slugify(letter.section || 'S');
    const studentName = slugify(letter.studentName || 'Student');
    const admissionNo = slugify(letter.admissionNo || '00000');
    return `${title}_${className}_${section}_${studentName}_${admissionNo}.${extension}`;
};

const getLetterDocxDownload = async (id, user) => {
    const letter = await IssuedLetter.findOne(tenantFilter(user, { _id: id }));
    if (!letter) {
        const err = new Error('Letter not found');
        err.statusCode = 404;
        throw err;
    }
    if (!letter.generatedDocxKey && !letter.generatedDocx) {
        const err = new Error('Generated document not found');
        err.statusCode = 404;
        throw err;
    }

    const buffer = letter.generatedDocxKey
        ? await s3StorageService.getBuffer(letter.generatedDocxKey)
        : letter.generatedDocx;

    return {
        buffer,
        filename: generateLetterFilename(letter, 'docx'),
        url: letter.generatedDocxUrl || null,
    };
};

module.exports = {
    autoGenerateLetterFromIncident,
    listIssuedLetters,
    getIssuedLetterById,
    getLettersByIncident,
    getLettersByStudent,
    getLetterStatusByIncidentIds,
    generateLetterFromIncident,
    updateIssuedLetter,
    deleteIssuedLetter,
    getLetterFilterOptions,
    getLetterDocxDownload,
    prepareDocxForDocxtemplater,
};
