require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const SchoolWorkspace = require('../models/SchoolWorkspace');
const Student = require('../models/Student');
const Incident = require('../models/Incident');
const Log = require('../models/Log');
const IssuedLetter = require('../models/IssuedLetter');
const BulkDeleteLog = require('../models/BulkDeleteLog');
const { inferAcademicYearFromDate } = require('../services/academicYearService');

const missingYearQuery = {
    $or: [
        { academicYear: { $exists: false } },
        { academicYear: null },
        { academicYear: '' },
    ],
};

const run = async () => {
    await connectDB();

    const workspaces = await SchoolWorkspace.find({});
    for (const workspace of workspaces) {
        const currentAcademicYear = workspace.currentAcademicYear || inferAcademicYearFromDate(workspace.createdAt);
        if (!workspace.currentAcademicYear) {
            workspace.currentAcademicYear = currentAcademicYear;
            await workspace.save();
        }

        const schoolId = workspace.schoolId;
        const students = await Student.find({ schoolId, ...missingYearQuery });
        for (const student of students) {
            const hasCurrentHistory = (student.history || []).some((entry) => entry?.academicYear === currentAcademicYear);
            student.academicYear = currentAcademicYear;
            if (!hasCurrentHistory) {
                student.history.push({
                    academicYear: currentAcademicYear,
                    className: student.className,
                    section: student.section,
                    status: student.status || 'Active',
                    updatedAt: student.updatedAt || student.createdAt || new Date(),
                });
            }
            await student.save();
        }

        await Incident.updateMany(
            { schoolId, ...missingYearQuery },
            [
                {
                    $set: {
                        academicYear: currentAcademicYear,
                        studentSnapshot: {
                            name: { $ifNull: [{ $arrayElemAt: ['$studentsInvolved', 0] }, ''] },
                            admissionNo: { $ifNull: ['$admissionNo', ''] },
                            className: { $ifNull: ['$class', ''] },
                            section: { $ifNull: ['$section', ''] },
                            academicYear: currentAcademicYear,
                        },
                    },
                },
            ]
        );

        await Log.updateMany({ schoolId, ...missingYearQuery }, { $set: { academicYear: currentAcademicYear } });
        await IssuedLetter.updateMany({ schoolId, ...missingYearQuery }, { $set: { academicYear: currentAcademicYear } });
        await BulkDeleteLog.updateMany({ schoolId, ...missingYearQuery }, { $set: { academicYear: currentAcademicYear } });
    }

    await mongoose.disconnect();
};

run().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect();
    process.exit(1);
});
