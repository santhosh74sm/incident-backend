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

        await Incident.collection.createIndex({ 'studentsInvolved': 1 });
        await Incident.collection.createIndex({ 'admissionNo': 1 });
        await Incident.collection.createIndex({ 'student': 1 });
        await Incident.collection.createIndex({ 'reportedBy': 1 });
        await Incident.collection.createIndex({ 'assignedHandler.name': 1 });
        await Incident.collection.createIndex({ 'category': 1 });
        await Incident.collection.createIndex({ 'status': 1 });
        await Incident.collection.createIndex({ 'createdAt': -1 });
        await Incident.collection.createIndex({ 'location': 1 });
        await Incident.collection.createIndex({
            studentsInvolved: 1,
            createdAt: -1
        });
        await Incident.collection.createIndex({
            category: 1,
            status: 1
        });
        await Incident.collection.createIndex({ student: 1, status: 1 });
        await Incident.collection.createIndex({ reportedBy: 1, createdAt: -1 });

        await Student.collection.createIndex({ 'admissionNo': 1 }, { unique: true });
        await Student.collection.createIndex({ 'name': 'text' });
        await Student.collection.createIndex({
            admissionNo: 'text',
            name: 'text'
        }, {
            weights: { admissionNo: 10, name: 5 }
        });
        await Student.collection.createIndex({ 'className': 1 });
        await Student.collection.createIndex({ 'section': 1 });
        await Student.collection.createIndex({ className: 1, section: 1 });

        await IssuedLetter.collection.createIndex({ 'incident': 1 });
        await IssuedLetter.collection.createIndex({ 'admissionNo': 1 });
        await IssuedLetter.collection.createIndex({ 'studentName': 1 });
        await IssuedLetter.collection.createIndex({ 'incidentCategory': 1 });
        await IssuedLetter.collection.createIndex({ 'generatedAt': -1 });
        await IssuedLetter.collection.createIndex({
            admissionNo: 1,
            generatedAt: -1
        });

        await LetterTemplate.collection.createIndex({ 'incidentCategory': 1 });
        await LetterTemplate.collection.createIndex({ 'isActive': 1 });
        await LetterTemplate.collection.createIndex({
            incidentCategory: 1,
            isActive: 1
        });
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
