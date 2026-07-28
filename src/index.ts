import { z } from "zod";

// JSON-RPC 2.0 message schemas
const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.any().optional(),
  id: z.union([z.string(), z.number()]).optional(),
});

// In-memory cache for ChatGPT fetch operations
const chatgptCache = new Map<string, any>();


/**
 * Handle MCP JSON-RPC 2.0 requests
 */
async function handleMcpRequest(request: any): Promise<any> {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            prompts: {},
          },
          serverInfo: {
            name: "WordPress Trac",
            version: "1.0.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "searchTickets",
              description: "Search for WordPress Trac tickets by keyword or filter expression. Returns ticket summaries with basic info.",
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Search query for tickets (keywords or filter expressions like 'summary~=keyword')",
                  },
                  limit: {
                    type: "number",
                    description: "Maximum number of results to return (default: 10, max: 50)",
                    default: 10,
                  },
                  status: {
                    type: "string",
                    description: "Filter by ticket status: accepted, assigned, closed, new, reopened, or reviewing",
                  },
                  component: {
                    type: "string", 
                    description: "Filter by component name (e.g., 'Administration', 'Posts, Post Types')",
                  },
                },
                required: ["query"],
              },
            },
            {
              name: "getTicket",
              description: "Get detailed information about a specific WordPress Trac ticket including description, comments, and metadata.",
              inputSchema: {
                type: "object",
                properties: {
                  id: {
                    type: "number",
                    description: "Trac ticket ID number",
                  },
                  includeComments: {
                    type: "boolean",
                    description: "Include ticket comments and discussion (default: true)",
                    default: true,
                  },
                  commentLimit: {
                    type: "number",
                    description: "Maximum number of comments to return (default: 10, max: 50)",
                    default: 10,
                  },
                },
                required: ["id"],
              },
            },
            {
              name: "getChangeset",
              description: "Get information about a specific WordPress code changeset/commit including commit message, author, and diff.",
              inputSchema: {
                type: "object",
                properties: {
                  revision: {
                    type: "number",
                    description: "SVN revision number (e.g., 58504)",
                  },
                  includeDiff: {
                    type: "boolean",
                    description: "Include diff content (default: true)",
                    default: true,
                  },
                  diffLimit: {
                    type: "number",
                    description: "Maximum characters of diff to return (default: 2000, max: 10000)",
                    default: 2000,
                  },
                },
                required: ["revision"],
              },
            },
            {
              name: "getTimeline",
              description: "Get recent activity from WordPress Trac timeline including recent tickets, commits, and other events.",
              inputSchema: {
                type: "object",
                properties: {
                  days: {
                    type: "number",
                    description: "Number of days to look back (default: 7, max: 30)",
                    default: 7,
                  },
                  limit: {
                    type: "number",
                    description: "Maximum number of events to return (default: 20, max: 100)",
                    default: 20,
                  },
                },
              },
            },
            {
              name: "getTracInfo",
              description: "Get WordPress Trac metadata like components, milestones, priorities, and severities.",
              inputSchema: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["components", "milestones", "priorities", "severities"],
                    description: "Type of Trac information to retrieve",
                  },
                },
                required: ["type"],
              },
            },
          ],
        },
      };

    case "tools/call":
      const { name, arguments: args } = params;
      
      try {
        let result;
        
        switch (name) {
          case "searchTickets": {
            const { query, limit = 10, status, component } = args;
            
            try {
              // Build Trac query URL
              const queryUrl = new URL('https://core.trac.wordpress.org/query');
              queryUrl.searchParams.set('format', 'csv');
              queryUrl.searchParams.set('max', Math.min(limit, 50).toString());
              
              // Add keyword search
              if (query.includes('=') || query.includes('~')) {
                // User provided a direct filter
                queryUrl.searchParams.set('summary', query);
              } else {
                // Search in summary with keyword
                queryUrl.searchParams.set('summary', `~${query}`);
              }
              
              // Add status filter
              if (status) {
                queryUrl.searchParams.set('status', status);
              }
              
              // Add component filter
              if (component) {
                queryUrl.searchParams.set('component', component);
              }

              // Query tickets with proper headers
              const response = await fetch(queryUrl.toString(), {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)',
                  'Accept': 'text/csv,text/plain,*/*',
                  'Accept-Language': 'en-US,en;q=0.9',
                }
              });
              
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }
              
              const csvData = await response.text();
              
              // Check if we got HTML instead of CSV (403 error)
              if (csvData.includes('<html>') || csvData.includes('403 Forbidden')) {
                // Fallback: try without search parameters
                const fallbackUrl = new URL('https://core.trac.wordpress.org/query');
                fallbackUrl.searchParams.set('format', 'csv');
                fallbackUrl.searchParams.set('max', Math.min(limit * 3, 100).toString()); // Get more to filter
                
                const fallbackResponse = await fetch(fallbackUrl.toString(), {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)',
                    'Accept': 'text/csv,text/plain,*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                  }
                });
                
                if (!fallbackResponse.ok) {
                  throw new Error(`Fallback query failed: ${fallbackResponse.status} ${fallbackResponse.statusText}`);
                }
                
                const fallbackData = await fallbackResponse.text();
                if (fallbackData.includes('<html>') || fallbackData.includes('403 Forbidden')) {
                  throw new Error('Access denied - both search and fallback queries returned HTML');
                }
                
                // Filter results client-side
                const allLines = fallbackData.trim().split('\n');
                const filteredLines = [allLines[0]]; // Keep header
                
                for (let i = 1; i < allLines.length && i < allLines.length; i++) {
                  const line = allLines[i];
                  if (line && line.toLowerCase().includes(query.toLowerCase())) {
                    filteredLines.push(line);
                    if (filteredLines.length > limit) break;
                  }
                }
                
                const result = { 
                  csvData: filteredLines.join('\n'), 
                  wasFiltered: true 
                };
                
                // Parse CSV data
                const lines = result.csvData.trim().split('\n');
                if (lines.length < 2) {
                  throw new Error('No tickets found matching search criteria');
                }
                
                const tickets = [];
                
                for (let i = 1; i < lines.length; i++) {
                  const line = lines[i]?.trim();
                  if (!line) continue;
                  
                  // Simple CSV parsing - handle quoted fields
                  const values = [];
                  let currentField = '';
                  let inQuotes = false;
                  
                  for (let j = 0; j < line.length; j++) {
                    const char = line[j];
                    if (char === '"' && (j === 0 || line[j-1] === ',')) {
                      inQuotes = true;
                    } else if (char === '"' && inQuotes && (j === line.length - 1 || line[j+1] === ',')) {
                      inQuotes = false;
                    } else if (char === ',' && !inQuotes) {
                      values.push(currentField.trim());
                      currentField = '';
                    } else {
                      currentField += char;
                    }
                  }
                  values.push(currentField.trim());
                  
                  if (values.length >= 2 && values[0] && !isNaN(parseInt(values[0]))) {
                    const ticket = {
                      id: parseInt(values[0]),
                      title: values[1] || '',
                      text: `#${values[0]}: ${values[1] || 'No summary'}\nStatus: ${values[2] || 'unknown'}\nOwner: ${values[3] || 'unassigned'}\nType: ${values[4] || 'unknown'}\nPriority: ${values[5] || 'unknown'}\nMilestone: ${values[6] || 'none'}`,
                      url: `https://core.trac.wordpress.org/ticket/${values[0]}`,
                      metadata: {
                        status: values[2] || 'unknown',
                        owner: values[3] || 'unassigned',
                        type: values[4] || 'unknown',
                        priority: values[5] || 'unknown',
                        milestone: values[6] || 'none',
                      },
                    };
                    
                    tickets.push(ticket);
                  }
                }

                return {
                  results: tickets,
                  query,
                  totalFound: tickets.length,
                  returned: tickets.length,
                  note: result.wasFiltered ? 'Results filtered client-side due to search API limitations' : undefined,
                };
              }
              
              const queryResult = { csvData, wasFiltered: false };
              
              // Parse CSV data
              const lines = queryResult.csvData.trim().split('\n');
              if (lines.length < 2) {
                throw new Error('No tickets found or invalid CSV response');
              }
              
              const tickets = [];
              
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i]?.trim();
                if (!line) continue;
                
                // Simple CSV parsing - handle quoted fields
                const values = [];
                let currentField = '';
                let inQuotes = false;
                
                for (let j = 0; j < line.length; j++) {
                  const char = line[j];
                  if (char === '"' && (j === 0 || line[j-1] === ',')) {
                    inQuotes = true;
                  } else if (char === '"' && inQuotes && (j === line.length - 1 || line[j+1] === ',')) {
                    inQuotes = false;
                  } else if (char === ',' && !inQuotes) {
                    values.push(currentField.trim());
                    currentField = '';
                  } else {
                    currentField += char;
                  }
                }
                values.push(currentField.trim());
                
                if (values.length >= 2 && values[0] && !isNaN(parseInt(values[0]))) {
                  const ticket = {
                    id: parseInt(values[0]),
                    title: values[1] || '',
                    text: `#${values[0]}: ${values[1] || 'No summary'}\nStatus: ${values[4] || 'unknown'}\nOwner: ${values[2] || 'unassigned'}\nType: ${values[3] || 'unknown'}\nPriority: ${values[5] || 'unknown'}\nMilestone: ${values[6] || 'none'}`,
                    url: `https://core.trac.wordpress.org/ticket/${values[0]}`,
                    metadata: {
                      status: values[4] || 'unknown',
                      owner: values[2] || 'unassigned',
                      type: values[3] || 'unknown',
                      priority: values[5] || 'unknown',
                      milestone: values[6] || 'none',
                    },
                  };
                  
                  tickets.push(ticket);
                }
              }

              result = {
                results: tickets,
                query,
                totalFound: tickets.length,
                returned: tickets.length,
                note: queryResult.wasFiltered ? 'Results filtered client-side due to search API limitations' : undefined,
              };
            } catch (error) {
              result = {
                results: [],
                query,
                error: error instanceof Error ? error.message : 'Unknown error',
              };
            }
            break;
          }

          case "getTicket": {
            const { id, includeComments = true } = args;
            
            try {
              // Use search approach since CSV parsing is problematic
              const searchUrl = new URL('https://core.trac.wordpress.org/query');
              searchUrl.searchParams.set('format', 'csv');
              searchUrl.searchParams.set('id', id.toString());
              searchUrl.searchParams.set('max', '1');
              
              const response = await fetch(searchUrl.toString(), {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)',
                  'Accept': 'text/csv,text/plain,*/*',
                }
              });
              
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }
              
              const csvData = await response.text();
              
              // Parse CSV data similar to searchTickets
              const lines = csvData.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
              if (lines.length < 2) {
                throw new Error(`Ticket ${id} not found`);
              }
              
              // Parse each line like in searchTickets
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i]?.trim();
                if (!line) continue;
                
                // Better CSV parsing - handle quoted fields properly
                const values = [];
                let currentField = '';
                let inQuotes = false;
                let escapeNext = false;
                
                for (let j = 0; j < line.length; j++) {
                  const char = line[j];
                  
                  if (escapeNext) {
                    currentField += char;
                    escapeNext = false;
                    continue;
                  }
                  
                  if (char === '\\') {
                    escapeNext = true;
                    continue;
                  }
                  
                  if (char === '"') {
                    if (inQuotes) {
                      // Check if this is an escaped quote
                      if (j + 1 < line.length && line[j + 1] === '"') {
                        currentField += '"';
                        j++; // Skip the next quote
                      } else {
                        inQuotes = false;
                      }
                    } else {
                      inQuotes = true;
                    }
                  } else if (char === ',' && !inQuotes) {
                    values.push(currentField.trim());
                    currentField = '';
                  } else {
                    currentField += char;
                  }
                }
                values.push(currentField.trim());
                
                if (values.length >= 2 && values[0] && !isNaN(parseInt(values[0]))) {
                  const ticketId = parseInt(values[0]);
                  if (ticketId === id) {
                    // Map fields based on actual headers from search query
                    // Headers: id,Summary,Owner,Type,Status,Priority,Milestone
                    const ticket = {
                      id: parseInt(values[0]),
                      summary: values[1] || '',
                      owner: values[2] || '',
                      type: values[3] || '',
                      status: values[4] || '',
                      priority: values[5] || '',
                      milestone: values[6] || '',
                      reporter: '', // Not available in search query
                      description: 'Full description not available in search query. Visit the ticket URL for complete details.',
                      component: '', // Not available in search query
                      version: '',
                      severity: '',
                      resolution: '',
                      keywords: '',
                      cc: '',
                      focuses: '',
                    };

                    // Note: Comments are not available through the CSV API
                    let comments: any[] = [];
                    
                    if (includeComments) {
                      comments = [{
                        author: 'system',
                        timestamp: new Date().toISOString(),
                        comment: 'Comment history not available through CSV API. Visit the ticket URL for full discussion.',
                      }];
                    }

                    result = {
                      id: id,
                      title: `#${id}: ${ticket.summary}`,
                      text: `Ticket #${id}: ${ticket.summary}\n\nStatus: ${ticket.status}\nComponent: ${ticket.component}\nPriority: ${ticket.priority}\nType: ${ticket.type}\nReporter: ${ticket.reporter}\nOwner: ${ticket.owner}\nMilestone: ${ticket.milestone}\nVersion: ${ticket.version}\nKeywords: ${ticket.keywords}\n\nDescription:\n${ticket.description}\n\nFor full discussion and comments, visit: https://core.trac.wordpress.org/ticket/${id}`,
                      url: `https://core.trac.wordpress.org/ticket/${id}`,
                      metadata: {
                        ticket,
                        comments,
                        totalComments: comments.length,
                      },
                    };
                    break; // Found the ticket, exit the loop
                  }
                }
              }
              
              // If we didn't find the ticket, result will be undefined
              if (!result) {
                throw new Error(`Ticket ${id} not found`);
              }
            } catch (error) {
              result = {
                id: id,
                title: `Error loading ticket ${id}`,
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                url: `https://core.trac.wordpress.org/ticket/${id}`,
                metadata: { error: true },
              };
            }
            break;
          }

          case "getChangeset": {
            const { revision, includeDiff = true, diffLimit = 2000 } = args;
            
            try {
              const changesetUrl = `https://core.trac.wordpress.org/changeset/${revision}`;
              
              // Fetch changeset page
              const response = await fetch(changesetUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
              });

              if (!response.ok) {
                throw new Error(`Changeset ${revision} not found`);
              }

              const html = await response.text();
              
              // Parse changeset information from HTML with improved patterns
              const messageMatch = html.match(/<dd class="message[^"]*"[^>]*>\s*<p[^>]*>(.*?)<\/p>/s) || 
                                  html.match(/<dd class="message[^"]*"[^>]*>(.*?)<\/dd>/s) ||
                                  html.match(/<div class="message"[^>]*>\s*<p[^>]*>(.*?)<\/p>/s) || 
                                  html.match(/<div class="message"[^>]*>(.*?)<\/div>/s);
              const authorMatch = html.match(/<dd class="author"[^>]*><span class="trac-author"[^>]*>(.*?)<\/span><\/dd>/s) ||
                                 html.match(/<dt class="property author">Author:<\/dt>\s*<dd class="author">(.*?)<\/dd>/s) ||
                                 html.match(/<dt>Author:<\/dt>\s*<dd>(.*?)<\/dd>/s);
              const dateMatch = html.match(/<dd class="date"[^>]*>(.*?)<\/dd>/s) ||
                               html.match(/<dt class="property date">Date:<\/dt>\s*<dd class="date">(.*?)<\/dd>/s) ||
                               html.match(/<dt>Date:<\/dt>\s*<dd>(.*?)<\/dd>/s);
              
              const changeset = {
                revision,
                author: authorMatch?.[1] ? authorMatch[1].replace(/<[^>]*>/g, '').trim() : '',
                date: dateMatch?.[1] ? dateMatch[1].replace(/<[^>]*>/g, '').trim() : '',
                message: messageMatch?.[1] ? messageMatch[1].replace(/<[^>]*>/g, '').trim() : '',
                files: [] as string[],
                diff: '',
              };

              // Extract file list with improved patterns
              const fileMatches = html.match(/<h2[^>]*>Files:<\/h2>([\s\S]*?)<\/div>/) ||
                                 html.match(/<div class="files"[^>]*>([\s\S]*?)<\/div>/) ||
                                 html.match(/<div[^>]*class="[^"]*files[^"]*"[^>]*>([\s\S]*?)<\/div>/);
              if (fileMatches?.[1]) {
                const fileListHtml = fileMatches[1];
                const filePathMatches = fileListHtml.match(/<a[^>]*href="[^"]*\/browser\/[^"]*"[^>]*>(.*?)<\/a>/g) ||
                                       fileListHtml.match(/<a[^>]*href="[^"]*"[^>]*>(.*?)<\/a>/g) ||
                                       fileListHtml.match(/<li[^>]*>(.*?)<\/li>/g);
                if (filePathMatches) {
                  changeset.files = filePathMatches
                    .map(match => match.replace(/<[^>]*>/g, '').trim())
                    .filter(path => path && !path.includes('(') && !path.includes('modified') && !path.includes('added') && !path.includes('deleted'))
                    .slice(0, 20); // Limit to first 20 files
                }
              }

              // Get diff if requested
              if (includeDiff) {
                try {
                  const diffUrl = `${changesetUrl}?format=diff`;
                  const diffResponse = await fetch(diffUrl, {
                    headers: {
                      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                  });

                  if (diffResponse.ok) {
                    let diffText = await diffResponse.text();
                    const maxDiffLength = Math.min(diffLimit, 10000);
                    if (diffText.length > maxDiffLength) {
                      diffText = diffText.substring(0, maxDiffLength) + '\n... [diff truncated] ...';
                    }
                    changeset.diff = diffText;
                  }
                } catch (error) {
                  console.warn('Failed to load diff:', error);
                }
              }

              result = {
                id: revision.toString(),
                title: `r${revision}: ${changeset.message}`,
                text: `Changeset r${revision}\nAuthor: ${changeset.author}\nDate: ${changeset.date}\n\nMessage:\n${changeset.message}\n\nFiles changed: ${changeset.files.length}\n${changeset.files.slice(0, 10).join('\n')}${changeset.files.length > 10 ? '\n...' : ''}\n\n${changeset.diff ? `Diff:\n${changeset.diff}` : 'No diff available'}`,
                url: changesetUrl,
                metadata: {
                  changeset,
                  totalFiles: changeset.files.length,
                },
              };
            } catch (error) {
              result = {
                id: revision.toString(),
                title: `Error loading changeset ${revision}`,
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                url: `https://core.trac.wordpress.org/changeset/${revision}`,
                metadata: { error: true },
              };
            }
            break;
          }

          case "getTimeline": {
            const { days = 7, limit = 20 } = args;
            
            try {
              const timelineUrl = `https://core.trac.wordpress.org/timeline?from=${days}%2Bdays+ago&max=${Math.min(limit, 100)}&format=rss`;
              
              const response = await fetch(timelineUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
              });

              if (!response.ok) {
                throw new Error(`Failed to fetch timeline: ${response.statusText}`);
              }

              const rssText = await response.text();
              
              // Better RSS parsing with multiple pattern attempts
              const itemMatches = rssText.match(/<item>([\s\S]*?)<\/item>/g);
              const events = [];
              
              if (itemMatches) {
                for (const itemMatch of itemMatches) {
                  // Try CDATA patterns first
                  let titleMatch = itemMatch.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s);
                  let linkMatch = itemMatch.match(/<link>(.*?)<\/link>/s);
                  let descMatch = itemMatch.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s);
                  let dateMatch = itemMatch.match(/<pubDate>(.*?)<\/pubDate>/s);
                  let creatorMatch = itemMatch.match(/<dc:creator>(.*?)<\/dc:creator>/s);
                  
                  // Fallback to non-CDATA patterns
                  if (!titleMatch) {
                    titleMatch = itemMatch.match(/<title>(.*?)<\/title>/s);
                  }
                  if (!descMatch) {
                    descMatch = itemMatch.match(/<description>(.*?)<\/description>/s);
                  }
                  
                  if (titleMatch && linkMatch) {
                    const title = titleMatch[1]?.trim() || 'Unknown Event';
                    const link = linkMatch[1]?.trim() || '';
                    const description = descMatch ? descMatch[1]?.replace(/<[^>]*>/g, '').trim() : '';
                    const date = dateMatch ? dateMatch[1]?.trim() : '';
                    const creator = creatorMatch ? creatorMatch[1]?.trim() : '';
                    
                    events.push({
                      id: link || `event-${events.length}`,
                      title,
                      text: `${title}\n\nAuthor: ${creator || 'Unknown'}\nDate: ${date || 'Unknown'}\n\n${description || 'No description available'}`,
                      url: link,
                      metadata: {
                        date,
                        author: creator,
                        description,
                      },
                    });
                  }
                }
              }

              result = {
                results: events,
                totalEvents: events.length,
                daysBack: days,
                timelineUrl: 'https://core.trac.wordpress.org/timeline',
              };
            } catch (error) {
              result = {
                results: [],
                error: error instanceof Error ? error.message : 'Unknown error',
                daysBack: days,
                timelineUrl: 'https://core.trac.wordpress.org/timeline',
              };
            }
            break;
          }

          case "getTracInfo": {
            const { type } = args;
            
            try {
              let data: any = {};
              let uniqueValues = new Set<string>();
              
              // Get a sample of tickets to extract unique values for the requested field
              const queryUrl = new URL('https://core.trac.wordpress.org/query');
              queryUrl.searchParams.set('format', 'csv');
              queryUrl.searchParams.set('max', '1000'); // Get more tickets for better coverage
              
              const response = await fetch(queryUrl.toString(), {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)',
                  'Accept': 'text/csv,text/plain,*/*',
                  'Accept-Language': 'en-US,en;q=0.9',
                }
              });
              
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }
              
              const csvData = await response.text();
              
              // Parse CSV data
              const lines = csvData.replace(/^\uFEFF/, '').trim().split('\n');
              const headers = (lines[0] || '').split(',').map(h => h.replace(/"/g, '').trim());
              
              // Find the column index for the requested type
              let columnIndex = -1;
              switch (type) {
                case "components":
                  // Components are not in the default query, need different approach
                  throw new Error(`Components list not available in default query. Try using the search function instead.`);
                case "milestones":
                  columnIndex = headers.indexOf('Milestone');
                  break;
                case "priorities":
                  columnIndex = headers.indexOf('Priority');
                  break;
                case "severities":
                  // Severities are not in the default query
                  throw new Error(`Severities list not available in default query. Try using the search function instead.`);
                case "types":
                  columnIndex = headers.indexOf('Type');
                  break;
                case "statuses":
                  columnIndex = headers.indexOf('Status');
                  break;
                default:
                  throw new Error(`Unknown info type: ${type}. Available types: milestones, priorities, types, statuses`);
              }
              
              if (columnIndex === -1) {
                throw new Error(`Column not found for type: ${type}. Available columns: ${headers.join(', ')}`);
              }
              
              // Extract unique values using better CSV parsing
              for (let i = 1; i < lines.length && lines[i]; i++) {
                const line = lines[i]?.trim();
                if (!line) continue;
                
                // Better CSV parsing - handle quoted fields properly
                const values = [];
                let currentField = '';
                let inQuotes = false;
                let escapeNext = false;
                
                for (let j = 0; j < line.length; j++) {
                  const char = line[j];
                  
                  if (escapeNext) {
                    currentField += char;
                    escapeNext = false;
                    continue;
                  }
                  
                  if (char === '\\') {
                    escapeNext = true;
                    continue;
                  }
                  
                  if (char === '"') {
                    if (inQuotes) {
                      // Check if this is an escaped quote
                      if (j + 1 < line.length && line[j + 1] === '"') {
                        currentField += '"';
                        j++; // Skip the next quote
                      } else {
                        inQuotes = false;
                      }
                    } else {
                      inQuotes = true;
                    }
                  } else if (char === ',' && !inQuotes) {
                    values.push(currentField.trim());
                    currentField = '';
                  } else {
                    currentField += char;
                  }
                }
                values.push(currentField.trim());
                
                if (values[columnIndex]?.trim()) {
                  uniqueValues.add(values[columnIndex]?.trim() || '');
                }
              }
              
              data = Array.from(uniqueValues).sort();

              result = {
                id: type,
                title: `WordPress Trac ${type}`,
                text: `${type.charAt(0).toUpperCase() + type.slice(1)} available in WordPress Trac:\n\n${data.join('\n')}`,
                url: 'https://core.trac.wordpress.org/',
                metadata: {
                  type,
                  data,
                  total: data.length,
                },
              };
            } catch (error) {
              result = {
                id: type,
                title: `Error loading ${type}`,
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Available types: components, milestones, priorities, severities, types, statuses`,
                url: 'https://core.trac.wordpress.org/',
                metadata: { error: true },
              };
            }
            break;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2)
            }],
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        };
      }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

/**
 * Handle ChatGPT-specific MCP JSON-RPC 2.0 requests
 * Follows OpenAI's requirements for Deep Research: simplified tools (search, fetch) and OpenAI response format
 */
async function handleChatGPTMcpRequest(request: any): Promise<any> {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "WordPress Trac",
            version: "1.0.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "search",
              description: `Search WordPress Trac for tickets, changesets, and timeline activity.

Query Types:
- Ticket searches: Use keywords like "block editor", "media upload", "REST API" to find related tickets
- Specific tickets: Use ticket numbers like "#61234" or "61234" to find specific tickets
- Changesets: Use revision numbers like "r58504" or "58504" to find code changes
- Recent activity: Use terms like "recent", "timeline", "latest" to see recent Trac activity
- Components: Search by component like "REST API", "Block Editor", "Media" to find tickets in that area`,
              inputSchema: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Search query for WordPress Trac. Can be keywords, ticket numbers, revision numbers, or component names.",
                  }
                },
                required: ["query"]
              }
            },
            {
              name: "fetch",
              description: "Retrieve detailed information about a specific WordPress Trac item by its ID.",
              inputSchema: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "The ID of the item to fetch detailed information for (e.g., '61234' for ticket, 'r58504' for changeset).",
                  }
                },
                required: ["id"]
              }
            }
          ],
        },
      };

    case "tools/call":
      const { name, arguments: args } = params;
      
      try {
        let result: any;
        
        switch (name) {
          case "search": {
            const { query } = args;
            
            try {
              // Intelligent query routing based on patterns
              const isTicketNumber = /^#?(\d+)$/.test(query.trim());
              const isRevisionNumber = /^r?(\d+)$/.test(query.trim()) && query.includes('r');
              const isTimelineQuery = /\b(recent|timeline|latest|activity)\b/i.test(query);
              
              let searchResults: any[] = [];
              
              if (isTicketNumber) {
                // Direct ticket lookup
                const ticketId = parseInt(query.replace('#', ''), 10);
                const ticketResult = await getTicketForChatGPT(ticketId, false);
                if (ticketResult && !ticketResult.metadata?.error) {
                  searchResults = [ticketResult];
                }
              } else if (isRevisionNumber) {
                // Direct changeset lookup
                const revision = parseInt(query.replace('r', ''), 10);
                const changesetResult = await getChangesetForChatGPT(revision, false);
                if (changesetResult && !changesetResult.metadata?.error) {
                  searchResults = [changesetResult];
                }
              } else if (isTimelineQuery) {
                // Timeline search
                const timelineResults = await getTimelineForChatGPT(7, 20);
                searchResults = timelineResults.results || [];
              } else {
                // Keyword search for tickets
                const ticketResults = await searchTicketsForChatGPT(query, 10);
                searchResults = ticketResults.results || [];
                
                // Also populate cache for potential fetch operations
                for (const ticketResult of searchResults) {
                  if (ticketResult.id && ticketResult.metadata?.ticket) {
                    chatgptCache.set(ticketResult.id, ticketResult.metadata.ticket);
                  }
                }
              }

              result = {
                results: searchResults,
                query,
                totalFound: searchResults.length,
              };
            } catch (error) {
              result = {
                results: [],
                query,
                error: error instanceof Error ? error.message : 'Unknown error',
              };
            }
            break;
          }

          case "fetch": {
            const { id } = args;
            
            try {
              // Determine if it's a ticket, changeset, or cached item
              const isRevision = /^r?\d+$/.test(id) && id.includes('r');
              const isTicketId = /^\d+$/.test(id);
              
              let fetchResult: any;
              
              if (chatgptCache.has(id)) {
                // Use cached data if available
                const cached = chatgptCache.get(id);
                fetchResult = await formatCachedTicketForChatGPT(cached, id);
              } else if (isRevision) {
                // Fetch changeset details
                const revision = parseInt(id.replace('r', ''), 10);
                fetchResult = await getChangesetForChatGPT(revision, true);
              } else if (isTicketId) {
                // Fetch ticket details
                const ticketId = parseInt(id, 10);
                fetchResult = await getTicketForChatGPT(ticketId, true);
              } else {
                throw new Error(`Invalid ID format: ${id}`);
              }

              result = fetchResult;
            } catch (error) {
              result = {
                id: id,
                title: `Error loading ${id}`,
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                url: `https://core.trac.wordpress.org/`,
                metadata: { error: true },
              };
            }
            break;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2)
            }],
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        };
      }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// Helper functions for ChatGPT response formatting

async function searchTicketsForChatGPT(query: string, limit: number) {
  // Reuse existing searchTickets logic but format for ChatGPT
  try {
    const queryUrl = new URL('https://core.trac.wordpress.org/query');
    queryUrl.searchParams.set('format', 'csv');
    queryUrl.searchParams.set('max', Math.min(limit, 50).toString());
    
    if (query.includes('=') || query.includes('~')) {
      queryUrl.searchParams.set('summary', query);
    } else {
      queryUrl.searchParams.set('summary', `~${query}`);
    }

    const response = await fetch(queryUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const csvData = await response.text();
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) {
      return { results: [] };
    }
    
    const results = [];
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      
      const values = parseCSVLine(line);
      if (values.length >= 2 && values[0] && !isNaN(parseInt(values[0]))) {
        const ticketId = parseInt(values[0]);
        const title = values[1] || '';
        const status = values[4] || 'unknown';
        const owner = values[2] || 'unassigned';
        const type = values[3] || 'unknown';
        const priority = values[5] || 'unknown';
        const milestone = values[6] || 'none';
        
        const ticket = {
          id: ticketId,
          title,
          status,
          owner,
          type,
          priority,
          milestone,
        };
        
        // Cache for potential fetch
        chatgptCache.set(ticketId.toString(), ticket);
        
        results.push({
          id: ticketId.toString(),
          title: `#${ticketId}: ${title}`,
          text: `Ticket #${ticketId}: ${title}\nStatus: ${status}\nType: ${type}\nPriority: ${priority}\nOwner: ${owner}\nMilestone: ${milestone}`,
          url: `https://core.trac.wordpress.org/ticket/${ticketId}`,
          metadata: { ticket },
        });
      }
    }

    return { results };
  } catch (error) {
    return { results: [], error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function getTicketForChatGPT(ticketId: number, includeComments: boolean) {
  try {
    const searchUrl = new URL('https://core.trac.wordpress.org/query');
    searchUrl.searchParams.set('format', 'csv');
    searchUrl.searchParams.set('id', ticketId.toString());
    searchUrl.searchParams.set('max', '1');
    
    const response = await fetch(searchUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const csvData = await response.text();
    const lines = csvData.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error(`Ticket ${ticketId} not found`);
    }
    
    const values = parseCSVLine(lines[1] || '');
    if (values.length >= 2 && values[0] && parseInt(values[0]) === ticketId) {
      const ticket = {
        id: parseInt(values[0]),
        summary: values[1] || '',
        owner: values[2] || '',
        type: values[3] || '',
        status: values[4] || '',
        priority: values[5] || '',
        milestone: values[6] || '',
      };

      // Cache the ticket
      chatgptCache.set(ticketId.toString(), ticket);

      const commentNote = includeComments 
        ? "\n\nNote: Full comments and description available on the ticket page."
        : "";

      return {
        id: ticketId.toString(),
        title: `#${ticketId}: ${ticket.summary}`,
        text: `Ticket #${ticketId}: ${ticket.summary}\n\nStatus: ${ticket.status}\nType: ${ticket.type}\nPriority: ${ticket.priority}\nOwner: ${ticket.owner}\nMilestone: ${ticket.milestone}${commentNote}`,
        url: `https://core.trac.wordpress.org/ticket/${ticketId}`,
        metadata: { ticket },
      };
    } else {
      throw new Error(`Ticket ${ticketId} not found`);
    }
  } catch (error) {
    return {
      id: ticketId.toString(),
      title: `Error loading ticket ${ticketId}`,
      text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      url: `https://core.trac.wordpress.org/ticket/${ticketId}`,
      metadata: { error: true },
    };
  }
}

async function getChangesetForChatGPT(revision: number, includeDiff: boolean) {
  try {
    const changesetUrl = `https://core.trac.wordpress.org/changeset/${revision}`;
    
    const response = await fetch(changesetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Changeset ${revision} not found`);
    }

    const html = await response.text();
    
    const messageMatch = html.match(/<dd class="message[^"]*"[^>]*>\s*<p[^>]*>(.*?)<\/p>/s) || 
                        html.match(/<dd class="message[^"]*"[^>]*>(.*?)<\/dd>/s);
    const authorMatch = html.match(/<dd class="author"[^>]*><span class="trac-author"[^>]*>(.*?)<\/span><\/dd>/s) ||
                       html.match(/<dt class="property author">Author:<\/dt>\s*<dd class="author">(.*?)<\/dd>/s);
    const dateMatch = html.match(/<dd class="date"[^>]*>(.*?)<\/dd>/s) ||
                     html.match(/<dt class="property date">Date:<\/dt>\s*<dd class="date">(.*?)<\/dd>/s);
    
    const changeset = {
      revision,
      author: authorMatch?.[1] ? authorMatch[1].replace(/<[^>]*>/g, '').trim() : '',
      date: dateMatch?.[1] ? dateMatch[1].replace(/<[^>]*>/g, '').trim() : '',
      message: messageMatch?.[1] ? messageMatch[1].replace(/<[^>]*>/g, '').trim() : '',
      diff: '',
    };

    // Get diff if requested
    if (includeDiff) {
      try {
        const diffUrl = `${changesetUrl}?format=diff`;
        const diffResponse = await fetch(diffUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        if (diffResponse.ok) {
          let diffText = await diffResponse.text();
          const maxDiffLength = 2000;
          if (diffText.length > maxDiffLength) {
            diffText = diffText.substring(0, maxDiffLength) + '\n... [diff truncated] ...';
          }
          changeset.diff = diffText;
        }
      } catch (error) {
        console.warn('Failed to load diff:', error);
      }
    }

    // Cache the changeset
    chatgptCache.set(`r${revision}`, changeset);

    const diffText = changeset.diff ? `\n\nDiff:\n${changeset.diff}` : '';

    return {
      id: `r${revision}`,
      title: `r${revision}: ${changeset.message}`,
      text: `Changeset r${revision}\nAuthor: ${changeset.author}\nDate: ${changeset.date}\n\nMessage:\n${changeset.message}${diffText}`,
      url: changesetUrl,
      metadata: { changeset },
    };
  } catch (error) {
    return {
      id: `r${revision}`,
      title: `Error loading changeset ${revision}`,
      text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      url: `https://core.trac.wordpress.org/changeset/${revision}`,
      metadata: { error: true },
    };
  }
}

async function getTimelineForChatGPT(days: number, limit: number) {
  try {
    const timelineUrl = `https://core.trac.wordpress.org/timeline?from=${days}%2Bdays+ago&max=${Math.min(limit, 100)}&format=rss`;
    
    const response = await fetch(timelineUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch timeline: ${response.statusText}`);
    }

    const rssText = await response.text();
    const itemMatches = rssText.match(/<item>([\s\S]*?)<\/item>/g);
    const results = [];
    
    if (itemMatches) {
      for (const itemMatch of itemMatches) {
        let titleMatch = itemMatch.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s);
        let linkMatch = itemMatch.match(/<link>(.*?)<\/link>/s);
        let descMatch = itemMatch.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s);
        let dateMatch = itemMatch.match(/<pubDate>(.*?)<\/pubDate>/s);
        let creatorMatch = itemMatch.match(/<dc:creator>(.*?)<\/dc:creator>/s);
        
        if (!titleMatch) titleMatch = itemMatch.match(/<title>(.*?)<\/title>/s);
        if (!descMatch) descMatch = itemMatch.match(/<description>(.*?)<\/description>/s);
        
        if (titleMatch && linkMatch) {
          const title = titleMatch[1]?.trim() || 'Unknown Event';
          const link = linkMatch[1]?.trim() || '';
          const description = descMatch ? descMatch[1]?.replace(/<[^>]*>/g, '').trim() : '';
          const date = dateMatch ? dateMatch[1]?.trim() : '';
          const creator = creatorMatch ? creatorMatch[1]?.trim() : '';
          
          results.push({
            id: link || `event-${results.length}`,
            title,
            text: `${title}\n\nAuthor: ${creator || 'Unknown'}\nDate: ${date || 'Unknown'}\n\n${description || 'No description available'}`,
            url: link,
            metadata: { date, author: creator, description },
          });
        }
      }
    }

    return { results };
  } catch (error) {
    return { results: [], error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function formatCachedTicketForChatGPT(cached: any, id: string) {
  return {
    id,
    title: `#${cached.id || id}: ${cached.summary || cached.title || 'Unknown'}`,
    text: `Ticket #${cached.id || id}: ${cached.summary || cached.title || 'Unknown'}\n\nStatus: ${cached.status || 'unknown'}\nType: ${cached.type || 'unknown'}\nPriority: ${cached.priority || 'unknown'}\nOwner: ${cached.owner || 'unassigned'}\nMilestone: ${cached.milestone || 'none'}\n\nNote: This is cached data. Visit the ticket URL for complete details.`,
    url: `https://core.trac.wordpress.org/ticket/${cached.id || id}`,
    metadata: { ticket: cached, cached: true },
  };
}

// Simple CSV parser helper
function parseCSVLine(line: string): string[] {
  const values = [];
  let currentField = '';
  let inQuotes = false;
  let escapeNext = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (escapeNext) {
      currentField += char;
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      if (inQuotes) {
        if (i + 1 < line.length && line[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        inQuotes = true;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  values.push(currentField.trim());
  return values;
}

// WordPress.com styled landing page
function getLandingPage(url: URL, versionInfo?: { id: string; tag?: string; timestamp: string }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WordPress Trac MCP Server</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url.origin}">
  <meta property="og:title" content="WordPress Trac MCP Server">
  <meta property="og:description" content="Model Context Protocol server for WordPress.org Trac integration">
  <meta property="og:image" content="${url.origin}/og-image.png">
  
  <!-- Twitter -->
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:url" content="${url.origin}">
  <meta property="twitter:title" content="WordPress Trac MCP Server">
  <meta property="twitter:description" content="Model Context Protocol server for WordPress.org Trac integration">
  <meta property="twitter:image" content="${url.origin}/og-image.png">
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #ffffff;
      max-width: 600px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    
    h1 {
      font-family: 'EB Garamond', serif;
      font-weight: 500;
      font-size: 2.25rem;
      color: #1a1a1a;
      margin-bottom: 0.5rem;
    }
    
    h2 {
      font-family: 'EB Garamond', serif;
      font-weight: 500;
      font-size: 1.5rem;
      color: #1a1a1a;
      margin: 2rem 0 1rem 0;
    }
    
    h3 {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
      font-weight: 600;
      font-size: 1.1rem;
      color: #1a1a1a;
      margin: 1.5rem 0 0.75rem 0;
    }
    
    p {
      margin-bottom: 1rem;
      color: #4a4a4a;
    }
    
    .subtitle {
      color: #666;
      margin-bottom: 2rem;
    }
    
    code {
      background: #f6f8fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      font-size: 0.9em;
      color: #3f57e1;
    }
    
    .code-block {
      background: #f6f8fa;
      border: 1px solid #e1e4e8;
      border-radius: 6px;
      padding: 1rem;
      margin: 1rem 0;
      overflow-x: auto;
    }
    
    .code-block code {
      background: none;
      padding: 0;
      color: #24292e;
    }
    
    .mcp-tool {
      margin-bottom: 0.75rem;
    }
    
    .mcp-tool code {
      font-weight: 600;
    }
    
    a {
      color: #3f57e1;
      text-decoration: none;
    }
    
    a:hover {
      text-decoration: underline;
    }
    
    .footer {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid #e1e4e8;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <h1>WordPress Trac MCP Server</h1>
  <p class="subtitle">Model Context Protocol server for WordPress.org Trac integration</p>
  
  <h2>Standard MCP Tools</h2>
  
  <div class="mcp-tool">
    <code>searchTickets</code> - Search for WordPress Trac tickets by keyword or filter
  </div>
  
  <div class="mcp-tool">
    <code>getTicket</code> - Get detailed information about a specific ticket
  </div>
  
  <div class="mcp-tool">
    <code>getChangeset</code> - Get information about a code changeset/commit
  </div>
  
  <div class="mcp-tool">
    <code>getTimeline</code> - Get recent activity from WordPress Trac
  </div>
  
  <div class="mcp-tool">
    <code>getTracInfo</code> - Get Trac metadata (components, milestones, priorities, severities)
  </div>

  <h2>ChatGPT Deep Research Tools</h2>
  
  <div class="mcp-tool">
    <code>search</code> - Intelligent search for tickets, changesets, and activity
  </div>
  
  <div class="mcp-tool">
    <code>fetch</code> - Get detailed information about specific items
  </div>
  
  <h2>Configuration</h2>
  
  <h3>Standard MCP (Claude Desktop, etc.)</h3>
  <div class="code-block">
    <code>{
  "mcpServers": {
    "wordpress-trac": {
      "command": "npx",
      "args": ["mcp-remote", "${url.origin}/mcp"]
    }
  }
}</code>
  </div>

  <h3>ChatGPT Deep Research</h3>
  <p>ChatGPT uses a different connection method:</p>
  <div class="code-block">
    <code>1. Open ChatGPT Settings → Connectors tab
2. Add Server → Import remote MCP server:
   ${url.origin}/mcp/chatgpt
3. Enable in Composer → Deep Research tool
4. Add as research source if needed</code>
  </div>
  <p>See: <a href="https://platform.openai.com/docs/mcp#connect-in-chatgpt">ChatGPT MCP Documentation</a></p>
  
  <div class="footer">
    <p><a href="https://core.trac.wordpress.org/">WordPress Trac</a> • <a href="https://modelcontextprotocol.io/">MCP Docs</a> • an experiment by <a href="https://automattic.ai">A8C AI</a></p>
    ${versionInfo ? `<p style="margin-top: 0.5rem; font-size: 0.8rem; color: #999;">
      Version: <code style="font-size: 0.8rem;">${versionInfo.id.substring(0, 8)}</code>
      ${versionInfo.tag ? ` • Tag: <code style="font-size: 0.8rem;">${versionInfo.tag}</code>` : ''}
      • Deployed: ${new Date(versionInfo.timestamp).toLocaleString()}
    </p>` : ''}
  </div>
</body>
</html>
  `;
}

// Environment interface
interface Env {
  ENVIRONMENT?: string;
  CF_VERSION_METADATA?: {
    id: string;
    tag?: string;
    timestamp: string;
  };
}

// Cloudflare Worker export
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Serve favicon
    if (url.pathname === "/favicon.ico") {
      // WordPress-style "W" favicon as base64
      const faviconBase64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAKPSURBVFiFtZe/axRBFMc/s3t7d3kTc4kJRpRYiIiNjYWNhYWFhY2FQkD8AxRsbCwsLCxsLGwsLCwsLCwsLCwsLCwUBEEQBEEQBEEQRBAiRo3Jmcvd7u6MxezO7d7tXS7qg2GZN+/H973vvZlZoUBEROYlWJRgXoKzwDRQKXJTGgYBNAQ8lOCGgG0iogqz4DtJsCLBvAT7iqTPCo4I0JGgKkExJR7PB7kpQVfAtd9lnyYjAVYFuCZg+n8wT8N+CVoClPtCQIT5lEwlLl6XNbqxNnVZY0LWeKiPMq9RLzKvFOCOBDsKid/VR3iv26RvJ/p1m3v6KLUirFOQSccdqsF1BYoJRIS5DNGEzLChQ8oqJCXiqjDGrjjyYb3HNQqSNQqSFfIyiJFE31bD+NJyOanHuF8LaBQkLgJ4AlbTzCM8K6zQVyF9FQIgoLTdQLo2nfCEbjhLJbiJjBgAdBRoJJmH9qJGQfJC7+NROkL0iXArJhD7aKsqHQklFWKpEICKbeKYfiZRRIJJMxpEKkrSlcAGKgLMJMlExOhLEq6AqQLi88rjlXkzfmQAbQWRfJdWHscMdGSErELGCohXBNC2TNysGODRNa22DRKYMkKgglGRPg9VBxEBvCjAGUdAxzJxlIuZJqKIBD0VENEHICoKD4DjJjAPBKxHNYKdQkcRtYzL7i1NCvyNOUQ5XgKcBLoiMCJ1BdZ9uJzXagtFEAMD9INP3I/o+RM8CPWvQAOY62e7RsEOEfmzP8BB4DxwFJg1x9uJtdOLN2AzZ7wtosOjDcO2rwEFGoAIiJI6LNYPZZw7oqBvAD6aG4wCBp9t4xdOBu6YRquJsQAAAABJRU5ErkJggg==";
      const faviconBuffer = Uint8Array.from(atob(faviconBase64), c => c.charCodeAt(0));
      
      return new Response(faviconBuffer, {
        headers: {
          "Content-Type": "image/x-icon",
          "Cache-Control": "public, max-age=31536000"
        }
      });
    }
    
    // Generate OG image
    if (url.pathname === "/og-image.png") {
      const title = (url.searchParams.get("title") || "WordPress Trac MCP Server")
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const subtitle = (url.searchParams.get("subtitle") || "Model Context Protocol server for WordPress.org Trac integration")
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      
      // Create a WordPress-branded OG image
      const svg = `
        <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <style>
              <![CDATA[
                @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;700&display=swap');
                .title { font-family: 'EB Garamond', serif; font-size: 48px; font-weight: 700; fill: white; }
                .subtitle { font-family: 'EB Garamond', serif; font-size: 24px; font-weight: 400; fill: rgba(255,255,255,0.9); }
              ]]>
            </style>
          </defs>
          
          <!-- WordPress Blue Background -->
          <rect width="1200" height="630" fill="#21759b"/>
          
          <!-- WordPress Icon in Upper Left -->
          <g transform="translate(60, 60) scale(0.8)">
            <g fill="white">
              <path d="m8.708 61.26c0 20.802 12.089 38.779 29.619 47.298l-25.069-68.686c-2.916 6.536-4.55 13.769-4.55 21.388z"/>
              <path d="m96.74 58.608c0-6.495-2.333-10.993-4.334-14.494-2.664-4.329-5.161-7.995-5.161-12.324 0-4.831 3.664-9.328 8.825-9.328.233 0 .454.029.681.042-9.35-8.566-21.807-13.796-35.489-13.796-18.36 0-34.513 9.42-43.91 23.688 1.233.037 2.395.063 3.382.063 5.497 0 14.006-.667 14.006-.667 2.833-.167 3.167 3.994.337 4.329 0 0-2.847.335-6.015.501l19.138 56.925 11.501-34.493-8.188-22.434c-2.83-.166-5.511-.501-5.511-.501-2.832-.166-2.5-4.496.332-4.329 0 0 8.679.667 13.843.667 5.496 0 14.006-.667 14.006-.667 2.835-.167 3.168 3.994.337 4.329 0 0-2.853.335-6.015.501l18.992 56.494 5.242-17.517c2.272-7.269 4.001-12.49 4.001-16.989z"/>
              <path d="m62.184 65.857-15.768 45.819c4.708 1.384 9.687 2.141 14.846 2.141 6.12 0 11.989-1.058 17.452-2.979-.141-.225-.269-.464-.374-.724z"/>
              <path d="m107.376 36.046c.226 1.674.354 3.471.354 5.404 0 5.333-.996 11.328-3.996 18.824l-16.053 46.413c15.624-9.111 26.133-26.038 26.133-45.426.001-9.137-2.333-17.729-6.438-25.215z"/>
              <path d="m61.262 0c-33.779 0-61.262 27.481-61.262 61.26 0 33.783 27.483 61.263 61.262 61.263 33.778 0 61.265-27.48 61.265-61.263-.001-33.779-27.487-61.26-61.265-61.26zm0 119.715c-32.23 0-58.453-26.223-58.453-58.455 0-32.23 26.222-58.451 58.453-58.451 32.229 0 58.45 26.221 58.45 58.451 0 32.232-26.221 58.455-58.45 58.455z"/>
            </g>
          </g>
          
          <!-- Title in Bottom Left -->
          <text x="60" y="520" class="title">${title}</text>
          
          <!-- Subtitle in Bottom Left -->
          <text x="60" y="560" class="subtitle">${subtitle}</text>
        </svg>
      `;
      
      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=31536000"
        }
      });
    }

    // Serve landing page at root
    if (url.pathname === "/") {
      const versionInfo = env.CF_VERSION_METADATA;
      return new Response(getLandingPage(url, versionInfo), {
        headers: { "Content-Type": "text/html" }
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Handle MCP endpoints
    if (url.pathname === "/mcp" || url.pathname === "/mcp/chatgpt") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        const body = await request.json();
        const mcpRequest = JsonRpcRequestSchema.parse(body);
        
        // Route to appropriate handler based on endpoint
        const response = url.pathname === "/mcp/chatgpt" 
          ? await handleChatGPTMcpRequest(mcpRequest)
          : await handleMcpRequest(mcpRequest);
        
        return new Response(JSON.stringify(response), {
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error",
          },
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
