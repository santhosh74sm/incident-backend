'use strict';

const mongoose = require('mongoose');
const Log = require('../models/Log');
const User = require('../models/User');
const logger = require('./pinoLogger');

const normalizeId = (value) => (value ? value.toString() : null);
const isObjectIdLike = (value) => Boolean(value && mongoose.Types.ObjectId.isValid(value.toString()));

const pickTargetLabel = (metadata = {}, fallbackEntityId = null) =>
    metadata.targetLabel ||
    metadata.Title ||
    metadata.title ||
    metadata.Name ||
    metadata.name ||
    metadata.studentName ||
    metadata.templateName ||
    metadata.letterNumber ||
    fallbackEntityId ||
    'System Record';

const pickAdmissionNumber = (metadata = {}) =>
    metadata.targetAdmissionNumber ||
    metadata['Admission Number'] ||
    metadata.admissionNo ||
    metadata.studentAdmissionNumber ||
    null;

const buildStudentDetails = (metadata = {}) => {
    const directStudents = Array.isArray(metadata.studentDetails?.studentsInvolved)
        ? metadata.studentDetails.studentsInvolved
        : [];
    const inferredStudents = Array.isArray(metadata.studentsInvolved)
        ? metadata.studentsInvolved
        : Array.isArray(metadata.students)
            ? metadata.students
            : metadata.studentName
                ? [metadata.studentName]
                : [];

    const studentsInvolved = [...new Set([...directStudents, ...inferredStudents].filter(Boolean))];
    const className = metadata.studentDetails?.class || metadata.class || metadata.className || '';
    const section = metadata.studentDetails?.section || metadata.section || '';
    const admissionNo =
        metadata.studentDetails?.admissionNo || metadata.admissionNo || metadata.targetAdmissionNumber || null;

    if (studentsInvolved.length === 0 && !className && !section) {
        return undefined;
    }

    return { studentsInvolved, class: className, section, admissionNo };
};

const buildRoutePath = (entityType, entityId, metadata = {}) => {
    if (metadata.routePath) return metadata.routePath;

    const incidentId =
        metadata.incidentId || metadata.incident || (entityType === 'Incident' ? entityId : null);
    const admissionNumber = pickAdmissionNumber(metadata);

    switch (entityType) {
        case 'Incident':
            return entityId ? `/incidents/${entityId}` : '/incidents';
        case 'Letter':
            return incidentId ? `/incidents/${incidentId}` : '/issued-letters';
        case 'Template':
            return '/letter-templates';
        case 'Student':
            return admissionNumber ? `/student-analytics/${admissionNumber}` : '/user-management';
        case 'Bulk Upload':
            return '/upload-incidents';
        case 'Analytics':
            return '/analytics';
        default:
            return '/logs';
    }
};

const buildNotificationMessage = ({ actionName, actorName, targetLabel, studentDetails, admissionNumber }) => {
    const parts = [];
    if (actorName) parts.push(actorName);

    const student = studentDetails?.studentsInvolved?.[0] || null;
    const cls = studentDetails?.class || null;
    const sec = studentDetails?.section || null;

    if (student) parts.push(student);
    if (admissionNumber) parts.push(`AdNo: ${admissionNumber}`);
    if (cls) parts.push(`Class ${cls}${sec ? ` – ${sec}` : ''}`);

    const context = parts.length > 0 ? ` [${parts.join(' | ')}]` : '';
    return targetLabel ? `${actionName}: ${targetLabel}${context}` : `${actionName}${context}`;
};

const resolveActorProfile = async (performedBy, notificationConfig = {}) => {
    const fallbackName =
        notificationConfig.performedByName ||
        (typeof performedBy === 'string' && !isObjectIdLike(performedBy) ? performedBy : 'System');
    const fallbackRole = notificationConfig.performedByRole || null;
    const actorId = normalizeId(performedBy);

    if (!actorId || !isObjectIdLike(actorId)) {
        return { actorId, performedByName: fallbackName, performedByRole: fallbackRole };
    }

    try {
        const user = await User.findById(actorId).select('name role').lean();
        if (user) {
            return {
                actorId,
                performedByName: notificationConfig.performedByName || user.name,
                performedByRole: notificationConfig.performedByRole || user.role || null,
            };
        }
    } catch (err) {
        logger.warn('resolveActorProfile: user lookup failed', { actorId, error: err.message });
    }

    return { actorId, performedByName: fallbackName, performedByRole: fallbackRole };
};

const resolveRecipientEntries = async (notificationConfig = {}, actorId = null) => {
    const collectedEntries = [];

    if (Array.isArray(notificationConfig.recipientEntries)) {
        collectedEntries.push(...notificationConfig.recipientEntries);
    }

    if (Array.isArray(notificationConfig.recipients)) {
        collectedEntries.push(...notificationConfig.recipients.map((recipient) => ({ recipient })));
    }

    if (Array.isArray(notificationConfig.recipientRoles) && notificationConfig.recipientRoles.length > 0) {
        const recipientRoles = new Set(notificationConfig.recipientRoles);
        if (recipientRoles.has('Teacher')) recipientRoles.add('teacher');
        const users = await User.find({ role: { $in: Array.from(recipientRoles) } })
            .select('_id')
            .lean();
        collectedEntries.push(...users.map((user) => ({ recipient: user._id })));
    }

    const dedupedEntries = new Map();

    collectedEntries
        .filter(Boolean)
        .forEach((entry) => {
            const normalizedEntry =
                typeof entry === 'string' || isObjectIdLike(entry)
                    ? { recipient: entry }
                    : entry;

            const recipientId = normalizeId(normalizedEntry.recipient);
            if (!recipientId) return;

            if (notificationConfig.excludeActor !== false && actorId && recipientId === actorId) {
                return;
            }

            dedupedEntries.set(recipientId, { ...normalizedEntry, recipient: recipientId });
        });

    return Array.from(dedupedEntries.values());
};

/**
 * Creates an audit log entry asynchronously (non-blocking via setImmediate).
 * Optionally creates Notification documents and pushes them via SSE.
 */
const createLog = (
    actionName,
    performedBy,
    entityType,
    entityId = null,
    metadata = {},
    notificationConfig = null
) => {
    setImmediate(async () => {
        const normalizedPerformedBy = normalizeId(performedBy) || 'System';
        const normalizedEntityId = normalizeId(entityId);

        try {
            await Log.create({
                actionName,
                performedBy: normalizedPerformedBy,
                entityType,
                entityId: normalizedEntityId,
                metadata,
            });
        } catch (err) {
            logger.error('Audit logging failed', { actionName, entityType, error: err.message });
        }

        if (!notificationConfig) return;

        try {
            const actorProfile = await resolveActorProfile(performedBy, notificationConfig);
            const recipientEntries = await resolveRecipientEntries(
                notificationConfig,
                actorProfile.actorId
            );

            if (recipientEntries.length === 0) return;

            const defaultIncidentId =
                notificationConfig.incidentId ||
                metadata.incidentId ||
                metadata.incident ||
                (entityType === 'Incident' ? normalizedEntityId : null);
            const defaultTargetLabel =
                notificationConfig.targetLabel || pickTargetLabel(metadata, normalizedEntityId);
            const defaultAdmissionNumber =
                notificationConfig.targetAdmissionNumber || pickAdmissionNumber(metadata);
            const defaultRoutePath =
                notificationConfig.routePath ||
                buildRoutePath(entityType, normalizedEntityId, metadata);
            const defaultStudentDetails =
                notificationConfig.studentDetails || buildStudentDetails(metadata);

            const notificationDocuments = recipientEntries.map((entry) => {
                const incidentId = entry.incidentId || defaultIncidentId;

                return {
                    recipient: entry.recipient,
                    type: entry.type || notificationConfig.type || 'SYSTEM_ACTIVITY',
                    incident: isObjectIdLike(incidentId) ? incidentId.toString() : null,
                    entityType: entry.entityType || notificationConfig.entityType || entityType,
                    entityId: entry.entityId || notificationConfig.entityId || normalizedEntityId,
                    actionName: entry.actionName || notificationConfig.actionName || actionName,
                    message:
                        entry.message ||
                        notificationConfig.message ||
                        buildNotificationMessage({
                            actionName,
                            actorName: actorProfile.performedByName,
                            targetLabel: entry.targetLabel || defaultTargetLabel,
                            studentDetails: entry.studentDetails || defaultStudentDetails,
                            admissionNumber:
                                entry.targetAdmissionNumber || defaultAdmissionNumber,
                        }),
                    performedBy: normalizedPerformedBy,
                    performedByName: actorProfile.performedByName,
                    performedByRole: actorProfile.performedByRole,
                    targetLabel: entry.targetLabel || defaultTargetLabel,
                    targetAdmissionNumber: entry.targetAdmissionNumber || defaultAdmissionNumber,
                    routePath: entry.routePath || defaultRoutePath,
                    metadata: { ...metadata, ...(entry.metadata || {}) },
                    studentDetails: entry.studentDetails || defaultStudentDetails,
                };
            });

            if (notificationDocuments.length > 0) {
                // insertAndPush saves to DB AND pushes SSE to each recipient
                const notificationService = require('../services/notificationService');
                await notificationService.insertAndPush(notificationDocuments);
            }
        } catch (err) {
            logger.error('Notification dispatch failed', { actionName, entityType, error: err.message });
        }
    });
};

module.exports = { createLog };
