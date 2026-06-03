'use strict';

const upload = require('../middleware/uploadMiddleware');
const letterTemplateService = require('../services/letterTemplateService');
const s3StorageService = require('../services/s3StorageService');

const getIncidentCategories = async (req, res, next) => {
    try {
        res.json(await letterTemplateService.getIncidentCategories(req.user));
    } catch (error) {
        next(error);
    }
};

const getLetterTemplates = async (req, res, next) => {
    try {
        res.json(await letterTemplateService.listLetterTemplates(req.user));
    } catch (error) {
        next(error);
    }
};

const getLetterTemplateById = async (req, res, next) => {
    try {
        res.json(await letterTemplateService.getLetterTemplateById(req.params.id, req.user));
    } catch (error) {
        next(error);
    }
};

const getTemplateByCategory = async (req, res, next) => {
    try {
        res.json(await letterTemplateService.getTemplateByCategory(req.params.category, req.user));
    } catch (error) {
        next(error);
    }
};

const createLetterTemplate = async (req, res, next) => {
    try {
        const template = await letterTemplateService.createLetterTemplate(req.body, req.user);
        res.status(201).json(template);
    } catch (error) {
        next(error);
    }
};

const updateLetterTemplate = async (req, res, next) => {
    try {
        const template = await letterTemplateService.updateLetterTemplate(req.params.id, req.body, req.user);
        res.json(template);
    } catch (error) {
        next(error);
    }
};

const uploadTemplateFileController = async (req, res, next) => {
    try {
        const template = await letterTemplateService.attachTemplateFile(
            req.params.id,
            req.body.language || 'en',
            req.file,
            req.user
        );

        res.json({
            message: 'File uploaded successfully',
            template,
        });
    } catch (error) {
        next(error);
    }
};

const deleteTemplateDocument = async (req, res, next) => {
    try {
        res.json(await letterTemplateService.removeTemplateVariant(
            req.params.id,
            req.query.lang || req.body?.lang || 'en',
            req.user
        ));
    } catch (error) {
        next(error);
    }
};

const deleteLetterTemplate = async (req, res, next) => {
    try {
        res.json(await letterTemplateService.deleteLetterTemplate(req.params.id, req.user));
    } catch (error) {
        next(error);
    }
};

const downloadTemplate = async (req, res, next) => {
    try {
        const { filePath, key, url, originalName } = await letterTemplateService.resolveTemplateDownloadPath(
            req.params.id,
            req.query.lang || 'en',
            req.user
        );

        if (key) {
            const buffer = await s3StorageService.getBuffer(key);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
            if (url) res.setHeader('X-S3-File-Url', url);
            return res.send(buffer);
        }

        res.download(filePath, originalName);
    } catch (error) {
        next(error);
    }
};

const downloadReferenceGuide = async (req, res, next) => {
    try {
        const guide = letterTemplateService.buildReferenceGuideText();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="smart-tags-reference-guide.txt"');
        res.send(guide);
    } catch (error) {
        next(error);
    }
};

const getSmartTags = async (req, res, next) => {
    try {
        res.json(letterTemplateService.getSmartTags());
    } catch (error) {
        next(error);
    }
};

const getAvailablePlaceholders = getSmartTags;

module.exports = {
    getIncidentCategories,
    getLetterTemplates,
    getLetterTemplateById,
    createLetterTemplate,
    uploadTemplateFile: upload.single('docx'),
    uploadTemplateFileController,
    updateLetterTemplate,
    deleteLetterTemplate,
    deleteTemplateDocument,
    downloadTemplate,
    downloadReferenceGuide,
    getSmartTags,
    getAvailablePlaceholders,
    getTemplateByCategory,
};
