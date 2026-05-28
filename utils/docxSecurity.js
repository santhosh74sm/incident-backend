'use strict';

const PizZip = require('pizzip');

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_DOCX_BYTES = Number(process.env.DOCX_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_DOCX_ENTRIES = Number(process.env.DOCX_MAX_ENTRIES) || 300;
const MAX_XML_ENTRY_BYTES = Number(process.env.DOCX_MAX_XML_ENTRY_BYTES) || 2 * 1024 * 1024;
const MAX_TEXT_CHARS = Number(process.env.DOCX_MAX_TEXT_CHARS) || 10000;

const stripInvalidXmlChars = (value) =>
    String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/\uFFFE|\uFFFF/g, '');

const clampText = (value, max = MAX_TEXT_CHARS) => {
    const clean = stripInvalidXmlChars(value);
    return clean.length > max ? `${clean.slice(0, max)}...` : clean;
};

const escapeXmlText = (value) =>
    clampText(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

const createDocxError = (message) => {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
};

const validateDocxBuffer = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw createDocxError('DOCX file is empty or unreadable.');
    }

    if (buffer.length > MAX_DOCX_BYTES) {
        throw createDocxError('DOCX file exceeds the allowed size.');
    }

    let zip;
    try {
        zip = new PizZip(buffer);
    } catch {
        throw createDocxError('DOCX file is malformed or corrupted.');
    }

    const entries = Object.keys(zip.files);
    if (entries.length > MAX_DOCX_ENTRIES) {
        throw createDocxError('DOCX file contains too many internal entries.');
    }

    if (!zip.files['word/document.xml'] || !zip.files['[Content_Types].xml']) {
        throw createDocxError('DOCX file is missing required document parts.');
    }

    for (const entryName of entries) {
        const entry = zip.files[entryName];
        if (entry.dir) continue;

        if (entryName.endsWith('.xml') || entryName.endsWith('.rels')) {
            const xml = entry.asText();
            if (Buffer.byteLength(xml, 'utf8') > MAX_XML_ENTRY_BYTES) {
                throw createDocxError('DOCX file contains an oversized XML part.');
            }
            if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
                throw createDocxError('DOCX file contains unsupported XML declarations.');
            }
            if (/TargetMode\s*=\s*["']External["']/i.test(xml)) {
                throw createDocxError('DOCX file contains external document relationships.');
            }
        }
    }

    return zip;
};

const paragraph = (text, { bold = false, size = null } = {}) => {
    const runProps = [
        bold ? '<w:b w:val="true"/>' : '',
        size ? `<w:sz w:val="${Number(size)}"/>` : '',
    ].filter(Boolean).join('');

    const safeText = escapeXmlText(text);
    return `<w:p><w:r>${runProps ? `<w:rPr>${runProps}</w:rPr>` : ''}<w:t xml:space="preserve">${safeText}</w:t></w:r></w:p>`;
};

const emptyParagraph = () => '<w:p><w:r><w:t></w:t></w:r></w:p>';

const createSimpleDocx = (paragraphs) => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join('\n    ')}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

    const zip = new PizZip();
    zip.file('word/document.xml', documentXml);
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
};

module.exports = {
    DOCX_MIME_TYPE,
    clampText,
    createSimpleDocx,
    emptyParagraph,
    escapeXmlText,
    paragraph,
    stripInvalidXmlChars,
    validateDocxBuffer,
};
