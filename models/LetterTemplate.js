const mongoose = require('mongoose');

const letterTemplateSchema = new mongoose.Schema({
    title: { 
        type: String, 
        required: true,
        trim: true
    },
    schoolId: {
        type: String,
        required: true,
        immutable: true,
        uppercase: true,
        trim: true,
        index: true,
    },
    incidentCategory: { 
        type: String, 
        required: true,
        trim: true,
        index: true
    },
    description: { 
        type: String,
        default: ''
    },
    hasEnglishVersion: {
        type: Boolean,
        default: false
    },
    hasTamilVersion: {
        type: Boolean,
        default: false
    },
    englishTemplateFile: {
        filename: { type: String },
        originalName: { type: String },
        path: { type: String },
        key: { type: String },
        url: { type: String },
        size: { type: Number },
        mimeType: { type: String }
    },
    tamilTemplateFile: {
        filename: { type: String },
        originalName: { type: String },
        path: { type: String },
        key: { type: String },
        url: { type: String },
        size: { type: Number },
        mimeType: { type: String }
    },
    isActive: { 
        type: Boolean, 
        default: true,
        index: true
    },
    createdBy: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, { 
    timestamps: true,
    collection: 'letter_templates'
});

letterTemplateSchema.index({ schoolId: 1, incidentCategory: 1 }, { unique: true });
letterTemplateSchema.index({ schoolId: 1, title: 1, incidentCategory: 1 }, { unique: true });

letterTemplateSchema.methods.hasFile = function(lang = 'en') {
    if (lang === 'en') {
        return !!(this.englishTemplateFile?.key || this.englishTemplateFile?.path);
    } else if (lang === 'ta') {
        return !!(this.tamilTemplateFile?.key || this.tamilTemplateFile?.path);
    }
    return false;
};

letterTemplateSchema.statics.getAvailableTags = function() {
    return [
        { tag: '{{studentName}}', description: 'Student Full Name' },
        { tag: '{{student_name}}', description: 'Student Full Name' },
        { tag: '[STUDENT_NAME]', description: 'Student Full Name' },
        { tag: '{{admissionNo}}', description: 'Admission Number' },
        { tag: '{{admission_no}}', description: 'Admission Number' },
        { tag: '[ADMISSION_NO]', description: 'Admission Number' },
        { tag: '{{class}}', description: 'Student Class' },
        { tag: '[CLASS]', description: 'Student Class' },
        { tag: '{{section}}', description: 'Student Section' },
        { tag: '[SECTION]', description: 'Student Section' },
        { tag: '{{date}}', description: 'Date' },
        { tag: '[DATE]', description: 'Date' },
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
        { tag: '{{year}}', description: 'Current Year' }
    ];
};

module.exports = mongoose.model('LetterTemplate', letterTemplateSchema);
