// api/timeline.js - Vercel API endpoint
const { generateDailySchedule } = require('../scheduler');

export default async function handler(req, res) {
    try {
        // Handle CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }
        
        // Get date parameter (optional)
        const targetDate = req.query.date || new Date().toISOString().split('T')[0];
        
        console.log(`🚀 Generating schedule for: ${targetDate}`);
        
        // Generate the complete schedule
        const result = await generateDailySchedule(targetDate);
        
        // Return HTML timeline if requested
        if (req.query.format === 'html' || req.headers.accept?.includes('text/html')) {
            res.setHeader('Content-Type', 'text/html');
            return res.status(200).send(result.htmlTimeline);
        }
        
        // Return JSON data
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({
            success: true,
            date: targetDate,
            schedule: result.schedule,
            morningData: result.morningData,
            workShift: result.workShift,
            taskSummary: {
                flexible: result.tasks.flexibleTasks.length,
                fixed: result.tasks.fixedTimeTasks.length
            },
            generatedAt: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ API Error:', error.message);
        
        res.setHeader('Content-Type', 'application/json');
        return res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}
