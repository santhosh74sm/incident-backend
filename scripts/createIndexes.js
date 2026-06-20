const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const createIndexes = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/st_incident_system');

        const Incident = require('../models/Incident');
        const Student = require('../models/Student');
        const IssuedLetter = require('../models/IssuedLetter');
        const LetterTemplate = require('../models/LetterTemplate');
        const User = require('../models/User');
        const Category = require('../models/Category');
        const Location = require('../models/Location');
        const EvidenceType = require('../models/EvidenceType');
        const FieldOperationOption = require('../models/FieldOperationOption');
        const SchoolWorkspace = require('../models/SchoolWorkspace');
        const IssuedLetterCounter = require('../models/IssuedLetterCounter');
        const Log = require('../models/Log');

        const safeDropIndex = async (collection, indexName) => {
            try {
                await collection.dropIndex(indexName);
            } catch (error) {
                if (error.codeName !== 'IndexNotFound' && error.code !== 27) {
                    throw error;
                }
            }
        };

        await Promise.all([
            safeDropIndex(Student.collection, 'admissionNo_1'),
            safeDropIndex(Student.collection, 'schoolId_1'),
            safeDropIndex(IssuedLetter.collection, 'letterNumber_1'),
            safeDropIndex(IssuedLetter.collection, 'schoolId_1'),
            safeDropIndex(IssuedLetter.collection, 'academicYear_1'),
            safeDropIndex(IssuedLetter.collection, 'incident_1'),
            safeDropIndex(IssuedLetter.collection, 'studentName_1'),
            safeDropIndex(IssuedLetter.collection, 'incidentCategory_1'),
            safeDropIndex(IssuedLetter.collection, 'status_1'),
            safeDropIndex(IssuedLetter.collection, 'generatedAt_1'),
            safeDropIndex(LetterTemplate.collection, 'incidentCategory_1'),
            safeDropIndex(Category.collection, 'name_1'),
            safeDropIndex(Location.collection, 'name_1'),
            safeDropIndex(EvidenceType.collection, 'name_1'),
            safeDropIndex(User.collection, 'schoolId_1'),
            safeDropIndex(Incident.collection, 'schoolId_1'),
            safeDropIndex(Incident.collection, 'academicYear_1'),
            safeDropIndex(Incident.collection, 'isHighPriority_1'),
            safeDropIndex(Incident.collection, 'admissionNo_1'),
            safeDropIndex(Incident.collection, 'student_1'),
            safeDropIndex(Incident.collection, 'reportedBy_1'),
            safeDropIndex(Log.collection, 'schoolId_1'),
            safeDropIndex(Log.collection, 'academicYear_1'),
        ]);

        await SchoolWorkspace.collection.createIndex({ schoolId: 1 }, { unique: true });
        await SchoolWorkspace.collection.createIndex({ email: 1 }, { unique: true });
        await User.collection.createIndex({ email: 1 }, { unique: true });
        await User.collection.createIndex({ schoolId: 1, role: 1 });

        await Incident.collection.createIndex({ schoolId: 1, 'studentsInvolved': 1 });
        await Incident.collection.createIndex({ schoolId: 1, 'admissionNo': 1 });
        await Incident.collection.createIndex({ schoolId: 1, 'student': 1 });
        await Incident.collection.createIndex({ schoolId: 1, 'reportedBy': 1 });
        await Incident.collection.createIndex({ schoolId: 1, 'category': 1 });
        await Incident.collection.createIndex({ schoolId: 1, 'status': 1 });
        await Incident.collection.createIndex({ schoolId: 1, 'createdAt': -1 });
        await Incident.collection.createIndex({ schoolId: 1, 'location': 1 });
        await Incident.collection.createIndex({
            schoolId: 1,
            studentsInvolved: 1,
            createdAt: -1
        });
        await Incident.collection.createIndex({
            schoolId: 1,
            category: 1,
            status: 1
        });
        await Incident.collection.createIndex({ schoolId: 1, student: 1, status: 1 });
        await Incident.collection.createIndex({ schoolId: 1, reportedBy: 1, createdAt: -1 });

        await Student.collection.createIndex({ schoolId: 1, admissionNo: 1 }, { unique: true });
        await Student.collection.createIndex({ schoolId: 1, 'name': 1 });
        await Student.collection.createIndex({
            schoolId: 1,
            admissionNo: 'text',
            name: 'text'
        }, {
            weights: { admissionNo: 10, name: 5 }
        });
        await Student.collection.createIndex({ schoolId: 1, 'className': 1 });
        await Student.collection.createIndex({ schoolId: 1, 'section': 1 });
        await Student.collection.createIndex({ schoolId: 1, className: 1, section: 1 });

        await IssuedLetter.collection.createIndex({ schoolId: 1, letterNumber: 1 }, { unique: true });
        await IssuedLetterCounter.collection.createIndex({ schoolId: 1, scope: 1, year: 1 }, { unique: true });
        await IssuedLetter.collection.createIndex({ schoolId: 1, 'incident': 1 });
        await IssuedLetter.collection.createIndex({ schoolId: 1, 'admissionNo': 1 });
        await IssuedLetter.collection.createIndex({ schoolId: 1, 'studentName': 1 });
        await IssuedLetter.collection.createIndex({ schoolId: 1, 'incidentCategory': 1 });
        await IssuedLetter.collection.createIndex({ schoolId: 1, 'generatedAt': -1 });
        await IssuedLetter.collection.createIndex({
            schoolId: 1,
            admissionNo: 1,
            generatedAt: -1
        });
        await IssuedLetter.collection.createIndex({
            schoolId: 1,
            incident: 1,
            generatedAt: -1
        });
        await IssuedLetter.collection.createIndex({
            schoolId: 1,
            incidentCategory: 1,
            generatedAt: -1
        });
        await IssuedLetter.collection.createIndex({
            schoolId: 1,
            status: 1,
            generatedAt: -1
        });

        await LetterTemplate.collection.createIndex({ schoolId: 1, incidentCategory: 1 }, { unique: true });
        await LetterTemplate.collection.createIndex({ schoolId: 1, 'isActive': 1 });
        await LetterTemplate.collection.createIndex({
            schoolId: 1,
            incidentCategory: 1,
            isActive: 1
        });

        await Category.collection.createIndex({ schoolId: 1, name: 1 }, { unique: true });
        await Location.collection.createIndex({ schoolId: 1, name: 1 }, { unique: true });
        await EvidenceType.collection.createIndex({ schoolId: 1, name: 1 }, { unique: true });
        await FieldOperationOption.collection.createIndex({ schoolId: 1, type: 1, order: 1 });

        await Log.collection.createIndex(
            { createdAt: 1 },
            { expireAfterSeconds: 365 * 24 * 3600, name: 'createdAt_1' }
        );
    } catch (error) {
        console.error('Index creation failed:', error);
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    createIndexes();
}

module.exports = createIndexes;
