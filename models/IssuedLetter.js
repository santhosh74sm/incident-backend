const mongoose = require('mongoose');

const issuedLetterSchema = new mongoose.Schema({
    letterNumber: {
        type: String,
        unique: true,
        index: true
    },
    incident: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Incident',
        required: true,
        index: true
    },
    studentName: {
        type: String,
        required: true,
        index: true
    },
    admissionNo: {
        type: String,
        default: ''
    },
    className: {
        type: String,
        default: ''
    },
    section: {
        type: String,
        default: ''
    },
    incidentCategory: {
        type: String,
        required: true,
        index: true
    },
    templateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LetterTemplate',
        required: true
    },
    title: {
        type: String,
        required: true
    },
    generatedDocx: {
        type: Buffer,
        default: null
    },
    issuedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['Issued', 'Printed', 'Sent'],
        default: 'Issued',
        index: true
    },
    language: {
        type: String,
        default: 'en'
    },
    printedAt: {
        type: Date,
        default: null
    },
    notes: {
        type: String,
        default: ''
    },
    generatedAt: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { 
    timestamps: true,
    collection: 'issued_letters'
});

issuedLetterSchema.index({ studentName: 1, className: 1 });
issuedLetterSchema.index({ className: 1, section: 1 });
issuedLetterSchema.index({ generatedAt: -1 });

issuedLetterSchema.statics.generateLetterNumber = async function() {
    const year = new Date().getFullYear();
    const lastLetter = await this.findOne({
        letterNumber: new RegExp(`^LET-${year}-`)
    }).sort({ letterNumber: -1 });

    if (!lastLetter || !lastLetter.letterNumber) {
        return `LET-${year}-00001`;
    }

    const match = lastLetter.letterNumber.match(/LET-\d{4}-(\d+)/);
    if (match && match[1]) {
        const nextNum = parseInt(match[1], 10) + 1;
        return `LET-${year}-${String(nextNum).padStart(5, '0')}`;
    }

    // Fallback if parsing fails
    const count = await this.countDocuments({
        letterNumber: new RegExp(`^LET-${year}-`)
    });
    return `LET-${year}-${String(count + 1).padStart(5, '0')}`;
};

issuedLetterSchema.statics.getStats = async function(query = {}) {
    const stats = await this.aggregate([
        { $match: query },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);
    
    const result = { total: 0, Issued: 0, Printed: 0, Sent: 0 };
    stats.forEach(s => {
        result[s._id] = s.count;
        result.total += s.count;
    });
    return result;
};

module.exports = mongoose.model('IssuedLetter', issuedLetterSchema);
