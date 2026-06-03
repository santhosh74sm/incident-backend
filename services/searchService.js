const Student = require('../models/Student');
const Incident = require('../models/Incident');
const IssuedLetter = require('../models/IssuedLetter');
const { tenantFilter } = require('../utils/tenant');

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildNavigationCommands = (query) => {
    const commands = [
        { title: 'Go to Dashboard', link: '/dashboard' },
        { title: 'Report New Incident', link: '/create-incident' },
        { title: 'View Incident List', link: '/incidents' },
        { title: 'View Analytics', link: '/analytics' },
        { title: 'View Student Analytics', link: '/student-analytics' },
        { title: 'View Issued Letters', link: '/issued-letters' },
    ];

    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return commands.slice(0, 5).map((command) => ({
            type: 'command',
            title: command.title,
            sub: 'Quick Navigation',
            link: command.link,
        }));
    }

    return commands
        .filter((command) => command.title.toLowerCase().includes(normalized))
        .slice(0, 6)
        .map((command) => ({
            type: 'command',
            title: command.title,
            sub: 'Quick Navigation',
            link: command.link,
        }));
};

const globalSearch = async (queryValue = '', actor) => {
    const query = String(queryValue || '').trim();
    if (!query) {
        return { results: buildNavigationCommands('') };
    }

    const regex = new RegExp(escapeRegex(query), 'i');

    const [students, incidents, letters] = await Promise.all([
        Student.find(tenantFilter(actor, {
            $or: [{ name: { $regex: regex } }, { admissionNo: { $regex: regex } }],
        }))
            .select('name admissionNo className section')
            .sort({ updatedAt: -1 })
            .limit(8)
            .lean(),
        Incident.find(tenantFilter(actor, {
            $or: [{ category: { $regex: regex } }, { title: { $regex: regex } }, { description: { $regex: regex } }],
        }))
            .select('title category status createdAt')
            .sort({ createdAt: -1 })
            .limit(8)
            .lean(),
        IssuedLetter.find(tenantFilter(actor, {
            $or: [{ letterNumber: { $regex: regex } }, { title: { $regex: regex } }],
        }))
            .select('letterNumber title incidentCategory generatedAt')
            .sort({ generatedAt: -1 })
            .limit(8)
            .lean(),
    ]);

    const studentResults = (students || []).map((student) => ({
        type: 'student',
        title: student?.name || 'Unknown Student',
        sub: `#${student?.admissionNo || 'N/A'}`,
        link: `/student-analytics/${student?.admissionNo || ''}`,
    }));

    const incidentResults = (incidents || []).map((incident) => ({
        type: 'incident',
        title: incident?.title || incident?.category || 'Incident',
        sub: incident?.category ? `${incident.category} • ${incident?.status || 'Open'}` : (incident?.status || 'Incident'),
        link: `/incidents/${incident?._id || ''}`,
    }));

    const letterResults = (letters || []).map((letter) => ({
        type: 'letter',
        title: letter?.title || letter?.letterNumber || 'Issued Letter',
        sub: letter?.letterNumber ? `${letter.letterNumber}${letter?.incidentCategory ? ` • ${letter.incidentCategory}` : ''}` : (letter?.incidentCategory || 'Letter'),
        link: '/issued-letters',
    }));

    return {
        results: [...studentResults, ...incidentResults, ...letterResults, ...buildNavigationCommands(query)].slice(0, 24),
    };
};

module.exports = { globalSearch };
