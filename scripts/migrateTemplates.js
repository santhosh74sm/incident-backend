const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const LetterTemplate = require('../models/LetterTemplate');
const Category = require('../models/Category');

const migrateTemplates = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/st_incident_system');

        const templatesWithoutCategory = await LetterTemplate.find({
            $or: [
                { incidentCategory: { $exists: false } },
                { incidentCategory: null },
                { incidentCategory: '' }
            ]
        });

        if (templatesWithoutCategory.length === 0) {
            await mongoose.disconnect();
            return;
        }

        const categories = await Category.find({});
        const categoryNames = categories.map(c => c.name);

        for (const template of templatesWithoutCategory) {
            let newCategory = null;

            if (categoryNames.length > 0) {
                const matchingCategory = categoryNames.find(cat =>
                    template.name.toLowerCase().includes(cat.toLowerCase())
                );

                if (matchingCategory) {
                    newCategory = matchingCategory;
                }
            }

            if (newCategory) {
                template.incidentCategory = newCategory;
                await template.save();
            }
        }
    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    migrateTemplates();
}

module.exports = migrateTemplates;
