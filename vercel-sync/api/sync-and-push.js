import { Client } from '@notionhq/client';
import { google } from 'googleapis';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID_SCHEDULE = process.env.DATABASE_ID_SCHEDULE;

const CONTEXT_TYPE_TO_CALENDAR_ID = {
  'Personal-Events': 'shamilarae@gmail.com',
  'Personal-Admin': 'ba46fd78742e193e5c80d2a0ce5cf83751fe66c8b3ac6433c5ad2eb3947295c8@group.calendar.google.com',
  'Personal-Appointment': '0nul0g0lvc35c0jto1u5k5o87s@group.calendar.google.com',
  'Family-Events': 'family13053487624784455294@group.calendar.google.com',
  'Work-Travel': 'oqfs36dkqfqhpkrpsmd146kfm4@group.calendar.google.com',
  'Work-Admin': '25a2b77c6b27260126cdf6171f6acee428b838e43615a6bbef498d8138047014@group.calendar.google.com',
  'Work-Deep Work': '09b6f8683cb5c58381f1ce55fb75d56f644187db041705dc85cec04d279cb7bb@group.calendar.google.com',
  'Work-Meeting': '80a0f0cdb416ef47c50563665533e3b83b30a5a9ca513bed4899045c9828b577@group.calendar.google.com',
  'Work-Routine': 'a110c482749029fc9ca7227691daa38f21f5a6bcc8dbf39053ad41f7b1d2bf09@group.calendar.google.com'
};

const notion = new Client({ auth: NOTION_TOKEN });

// Initialize Google Calendar API
let calendar;
try {
  const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
  scopes: ['https://www.googleapis.com/auth/calendar']
});
  calendar = google.calendar({ version: 'v3', auth });
} catch (error) {
  console.error('Google Calendar auth failed:', error);
}

async function syncCalendarToNotion() {
  try {
    console.log('Sync started: Google Calendar → Notion');
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;

    for (const [contextType, calId] of Object.entries(CONTEXT_TYPE_TO_CALENDAR_ID)) {
      const [context, type] = contextType.split('-');
      
      try {
        const eventsResult = await calendar.events.list({
          calendarId: calId,
          timeMin: now,
          maxResults: 20,
          singleEvents: true,
          orderBy: 'startTime'
        });

        const events = eventsResult.data.items || [];
        console.log(`Found ${events.length} events in calendar: ${calId}`);

        for (const event of events) {
          const gCalId = event.id;
          if (!gCalId) continue;

          const title = event.summary || 'No Title';
          const start = event.start?.dateTime || event.start?.date;
          const end = event.end?.dateTime || event.end?.date;

          console.log(`Event: ${title} | Start: ${start} | GCal ID: ${gCalId}`);

          let durationMinutes = null;
          try {
            const startDt = new Date(start);
            const endDt = new Date(end);
            durationMinutes = Math.round((endDt - startDt) / (1000 * 60));
          } catch (error) {
            console.warn('Duration calculation failed:', error);
          }

          // Check if entry already exists in Notion
          const existing = await notion.databases.query({
            database_id: DATABASE_ID_SCHEDULE,
            filter: {
              property: 'GCal ID',
              rich_text: { equals: gCalId }
            }
          });

          const properties = {
            'Name': { title: [{ text: { content: title } }] },
            'Start Time': { date: { start: start } },
            'End Time': { date: { start: end } },
            'GCal ID': { rich_text: [{ text: { content: gCalId } }] },
            'Context': { select: { name: context } },
            'Type': { select: { name: type } }
          };

          if (durationMinutes !== null) {
            properties['Duration'] = { number: durationMinutes };
          }

          const activeResults = existing.results.filter(page => !page.archived);
          if (activeResults.length > 0) {
            await notion.pages.update({
              page_id: activeResults[0].id,
              properties: properties
            });
            updated++;
          } else {
            await notion.pages.create({
              parent: { database_id: DATABASE_ID_SCHEDULE },
              properties: properties
            });
            added++;
          }
        }
      } catch (error) {
        console.error(`Error syncing calendar ${calId}:`, error);
      }
    }

    console.log(`Sync complete: Added ${added} | Updated ${updated}`);
    return { status: 'success', added, updated };

  } catch (error) {
    console.error('Sync failed:', error);
    return { status: 'error', message: error.message };
  }
}

async function pushNotionToCalendar() {
  try {
    console.log('Push started: Notion → Google Calendar');
    
    const newPages = await notion.databases.query({
      database_id: DATABASE_ID_SCHEDULE,
      filter: {
        property: 'GCal ID',
        rich_text: { is_empty: true }
      }
    });

    let pushed = 0;

    for (const page of newPages.results) {
      const props = page.properties;

      try {
        const title = props.Name?.title?.[0]?.text?.content;
        const start = props['Start Time']?.date?.start;
        const endRaw = props['End Time']?.date;
        const end = endRaw?.start;
        const context = props.Context?.select?.name;
        const type = props.Type?.select?.name;

        if (!title || !start || !context || !type) {
          console.warn('Skipping page with missing required fields');
          continue;
        }

        const calendarKey = `${context}-${type}`;
        const calendarId = CONTEXT_TYPE_TO_CALENDAR_ID[calendarKey];
        
        if (!calendarId) {
          console.warn(`No calendar found for ${context}-${type}`);
          continue;
        }

        const startDt = new Date(start);
        let endDt;
        
        if (end) {
          endDt = new Date(end);
          if (endDt <= startDt) {
            endDt = new Date(startDt.getTime() + 15 * 60 * 1000); // 15 min default
          }
        } else {
          endDt = new Date(startDt.getTime() + 15 * 60 * 1000);
        }

        const event = {
          summary: title,
          start: { dateTime: startDt.toISOString() },
          end: { dateTime: endDt.toISOString() }
        };

        const created = await calendar.events.insert({
          calendarId: calendarId,
          resource: event
        });

        const gCalId = created.data.id;

        // Update Notion page with GCal ID
        await notion.pages.update({
          page_id: page.id,
          properties: {
            'GCal ID': { rich_text: [{ text: { content: gCalId } }] }
          }
        });

        pushed++;
        console.log(`Pushed: ${title}`);

      } catch (error) {
        console.error('Error pushing page:', error);
      }
    }

    console.log(`Push complete: ${pushed} events pushed`);
    return { status: 'success', pushed };

  } catch (error) {
    console.error('Push failed:', error);
    return { status: 'error', message: error.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Starting sync and push...');
    
    const syncResult = await syncCalendarToNotion();
    const pushResult = await pushNotionToCalendar();
    
    const success = syncResult.status === 'success' && pushResult.status === 'success';
    
    res.status(success ? 200 : 500).json({
      sync: syncResult,
      push: pushResult,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Handler error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
