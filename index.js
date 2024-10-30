const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const DxfParser = require('dxf-parser');
const CloudConvert = require('cloudconvert');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' }); // Temporary storage for uploaded files

// Initialize CloudConvert with API key from environment variables
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

// Function to convert .dwg to .dxf using CloudConvert API
async function convertDwgToDxf(inputFilePath) {
    try {
        const job = await cloudConvert.jobs.create({
            tasks: {
                'import-upload': {
                    operation: 'import/upload'
                },
                'convert': {
                    operation: 'convert',
                    input: 'import-upload',
                    input_format: 'dwg',
                    output_format: 'dxf'
                    // Removed the engine parameter since CloudConvert will auto-select the appropriate one
                },
                'export-url': {
                    operation: 'export/url',
                    input: 'convert'
                }
            }
        });

        // Upload file
        const uploadTask = job.tasks.filter(task => task.name === 'import-upload')[0];
        const formData = new FormData();
        
        // Add all parameters from the form
        Object.entries(uploadTask.result.form.parameters).forEach(([key, value]) => {
            formData.append(key, value);
        });
        
        // Append the file properly
        formData.append('file', fs.createReadStream(inputFilePath));

        // Make the upload request with proper headers
        await axios.post(uploadTask.result.form.url, formData, {
            headers: {
                ...formData.getHeaders()
            }
        });

        // Wait for the job to complete
        const completedJob = await cloudConvert.jobs.wait(job.id);
        const exportTask = completedJob.tasks.filter(task => task.name === 'export-url')[0];

        // Download the converted file
        const downloadUrl = exportTask.result.files[0].url;
        const response = await axios.get(downloadUrl, { responseType: 'stream' });
        const outputFilePath = inputFilePath.replace(/\.dwg$/i, '.dxf');
        const writer = fs.createWriteStream(outputFilePath);

        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(outputFilePath));
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('Detailed error:', error.response?.data || error);
        throw new Error(`Conversion error: ${error.message}`);
    }
}

// Function to validate .dxf file
async function validateDxfFile(filePath) {
    const parser = new DxfParser();
    try {
        const data = fs.readFileSync(filePath);
        const dxf = parser.parseSync(data);

        const entities = dxf.entities;
        const buildings = [];
        const boundaries = [];

        // Extract buildings and boundaries based on layers
        entities.forEach(entity => {
            if (entity.layer === 'BUILDING') {
                buildings.push(entity);
            } else if (entity.layer === 'BOUNDARY') {
                boundaries.push(entity);
            }
        });

        // Perform setback validation
        const validations = {
            setbackCompliance: checkSetbackDistance(buildings, boundaries),
        };

        return validations;
    } catch (error) {
        throw new Error('Error processing DXF file: ' + error.message);
    }
}

// Function to calculate distance between building and boundary entities
function calculateDistance(entity1, entity2) {
    const xDist = Math.max(0, Math.abs(entity1.x - entity2.x) - (entity1.width / 2 + entity2.width / 2));
    const yDist = Math.max(0, Math.abs(entity1.y - entity2.y) - (entity1.height / 2 + entity2.height / 2));
    return Math.sqrt(xDist ** 2 + yDist ** 2);
}

// Function to check setback distance
const MIN_SETBACK_DISTANCE = 10; // 10 feet

function checkSetbackDistance(buildings, boundaries) {
    for (let building of buildings) {
        for (let boundary of boundaries) {
            const distance = calculateDistance(building, boundary);

            if (distance >= MIN_SETBACK_DISTANCE) {
                return {
                    compliant: true,
                    message: `Building is ${distance} feet away from boundary on one side.`,
                };
            }
        }
    }

    return {
        compliant: false,
        message: 'Building does not meet the 10-ft setback requirement on any side.',
    };
}

// Endpoint to upload .dwg file, convert to .dxf, and validate
app.post('/upload', upload.single('dwgFile'), async (req, res) => {
    try {
        const dwgFilePath = req.file.path;

        // Convert .dwg to .dxf
        const dxfFilePath = await convertDwgToDxf(dwgFilePath);

        // Validate the converted .dxf file
        const validationResult = await validateDxfFile(dxfFilePath);

        // Clean up files
        fs.unlinkSync(dwgFilePath);
        fs.unlinkSync(dxfFilePath);

        // Respond with validation results
        res.json(validationResult);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(3000, () => console.log('Server is running on http://localhost:3000'));
