/**
 * issuedLetterController.js
 * Thin HTTP adapter — delegates ALL business logic to issuedLetterService.
 * Handles only: request parsing, response formatting, HTTP status codes.
 */

'use strict';

const issuedLetterService = require('../services/issuedLetterService');

// ─────────────────────────────────────────────────────────────────────────────
// List all issued letters (paginated, filtered)
// ─────────────────────────────────────────────────────────────────────────────

const getIssuedLetters = async (req, res, next) => {
    try {
        // Ensure student-based filters (class and section) are properly mapped for the backend query
        if (req.query.class) {
            req.query.className = req.query.class;
        }

        const result = await issuedLetterService.listIssuedLetters(req.query);

        if (result.paginated) {
            return res.json({ data: result.data, pagination: result.pagination });
        }

        return res.json(result.data);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get single issued letter by ID
// ─────────────────────────────────────────────────────────────────────────────

const getIssuedLetterById = async (req, res, next) => {
    try {
        const letter = await issuedLetterService.getIssuedLetterById(req.params.id);
        res.json(letter);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get letters by incident ID
// ─────────────────────────────────────────────────────────────────────────────

const getLetterByIncident = async (req, res, next) => {
    try {
        const letters = await issuedLetterService.getLettersByIncident(req.params.incidentId, req.user);
        res.json(letters);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get letters by student admission number
// ─────────────────────────────────────────────────────────────────────────────

const getLettersByStudent = async (req, res, next) => {
    try {
        const letters = await issuedLetterService.getLettersByStudent(req.params.admissionNo, req.query, req.user);
        res.json(letters);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get letter status map for multiple incidents (batch)
// ─────────────────────────────────────────────────────────────────────────────

const getLetterStatusByIncidentIds = async (req, res, next) => {
    try {
        const statusMap = await issuedLetterService.getLetterStatusByIncidentIds(req.body.incidentIds, req.user);
        res.json(statusMap);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Generate a letter from an incident (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

const createIssuedLetterFromIncident = async (req, res, next) => {
    try {
        const incidentId = req.body.incidentId || req.body.incident;
        const language = req.body.language || req.body.letterLanguage || 'en';

        if (!incidentId) {
            return res.status(400).json({ message: 'Incident ID is required to generate a letter.' });
        }

        const { alreadyExists, letter } = await issuedLetterService.generateLetterFromIncident(incidentId, language, req.user.id);

        if (alreadyExists) {
            return res.status(200).json({ message: 'Letter already generated for this incident.', letter });
        }

        res.status(201).json({ message: 'Letter generated successfully.', letter });
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Update issued letter (status, notes)
// ─────────────────────────────────────────────────────────────────────────────

const updateIssuedLetter = async (req, res, next) => {
    try {
        const letter = await issuedLetterService.updateIssuedLetter(req.params.id, req.body, req.user.id);
        res.json(letter);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Delete issued letter (Admin only)
// ─────────────────────────────────────────────────────────────────────────────

const deleteIssuedLetter = async (req, res, next) => {
    try {
        const result = await issuedLetterService.deleteIssuedLetter(req.params.id, req.user.id);
        res.json(result);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get filter options for dropdowns
// ─────────────────────────────────────────────────────────────────────────────

const getFilters = async (req, res, next) => {
    try {
        const filters = await issuedLetterService.getLetterFilterOptions();
        res.json(filters);
    } catch (error) {
        next(error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Download generated DOCX letter
// ─────────────────────────────────────────────────────────────────────────────

const downloadIssuedLetter = async (req, res, next) => {
    try {
        const { buffer, filename, url } = await issuedLetterService.getLetterDocxDownload(req.params.id);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (url) res.setHeader('X-S3-File-Url', url);
        res.send(buffer);
    } catch (error) {
        next(error);
    }
};


module.exports = {
    getIssuedLetters,
    getIssuedLetterById,
    getLetterByIncident,
    getLettersByStudent,
    getLetterStatusByIncidentIds,
    createIssuedLetterFromIncident,
    updateIssuedLetter,
    deleteIssuedLetter,
    getFilters,
    downloadIssuedLetter,
};
