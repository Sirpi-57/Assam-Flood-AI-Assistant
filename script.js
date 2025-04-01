document.addEventListener('DOMContentLoaded', function() {
    // --- Configuration ---
    // !!! IMPORTANT: SECURITY WARNING - Use a backend proxy for production !!!
    const GEMINI_API_KEY = 'AIzaSyCEGumBTF0Gs0yCbVIPvRsjjxPnazqQujU'; // <-- PASTE YOUR ACTUAL GEMINI API KEY HERE

    // Ensure the model name is correct (e.g., gemini-1.5-pro-latest)
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_API_KEY}`;

    // --- Map Setup ---
    const map = L.map('map').setView([26.2006, 92.9376], 7); // Centered on Assam
    let allData = []; // Holds the parsed CSV data
    let markersLayer = L.layerGroup().addTo(map); // Layer group for map markers
    const validCsvHeaders = [ // Define expected headers for validation & LLM prompt
        "RecordID", "Year", "Month", "District", "LocationName",
        "Latitude", "Longitude", "MainRiver", "RiverLevel",
        "MonthlyRainfall_mm", "FloodSeverity", "AffectedPopulation_Est",
        "LandslideCount_Reported", "LandslideRisk", "FloodRiskForecast", "DataSource"
    ];

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // --- UI Elements ---
    const chatbox = document.getElementById('chatbox');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const voiceButton = document.getElementById('voiceButton');
    const loadingIndicator = document.getElementById('loadingIndicator');

    // --- State Variables ---
    let conversationHistory = []; // Stores user/assistant chat turns for context
    let isRecognizing = false;
    let recognition;
    let lastInputWasVoice = false; // Track if the last input was from voice

    // --- Initialization ---
    loadData();
    setupSpeechRecognition();

    // --- Event Listeners ---
    sendButton.addEventListener('click', function() {
        lastInputWasVoice = false; // Text input via button
        handleUserInput();
    });
    userInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            lastInputWasVoice = false; // Text input via keyboard
            handleUserInput();
        }
    });
    voiceButton.addEventListener('click', toggleVoiceRecognition);

    // =========================================================================
    // Data Loading and Validation
    // =========================================================================

    function loadData() {
        fetch('assam_flood_data_v2.csv') // Ensure this filename matches
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.text();
            })
            .then(csvText => {
                Papa.parse(csvText, {
                    header: true,
                    skipEmptyLines: true,
                    complete: function(results) {
                        if (results.data && results.data.length > 0 && results.meta && results.meta.fields) {
                            // Basic header validation
                            const actualHeaders = results.meta.fields;
                            const missingHeaders = validCsvHeaders.filter(h => !actualHeaders.includes(h));

                            if (missingHeaders.length > 0) {
                                console.warn("CSV Data Warning: Missing expected headers:", missingHeaders.join(', '));
                                // Decide if this is critical - for now, we'll proceed but log warning
                            }
                             if (!actualHeaders.includes("Latitude") || !actualHeaders.includes("Longitude") || !actualHeaders.includes("Year") || !actualHeaders.includes("Month") || !actualHeaders.includes("District")) {
                                 throw new Error("CSV data is critically incomplete. Essential headers (Latitude, Longitude, Year, Month, District) are missing.");
                             }

                            allData = results.data;
                            console.log(`Loaded ${allData.length} data records.`);
                            const welcomeMsg = "I have sample monthly data on Assam floods and landslides (2021-23). Ask me questions about the data (e.g., 'show severe floods in Barpeta during 2023', 'landslide risk in Dima Hasao', 'rainfall above 500mm in July'). You can type or use the microphone.";
                            addMessageToChat(welcomeMsg, 'assistant'); // Changed role for clarity
                            // Welcome message is always spoken for better UX
                            speakText(welcomeMsg);

                        } else {
                            throw new Error("CSV parsing failed or file is empty/invalid.");
                        }
                    },
                    error: function(error) {
                        handleError("Error parsing CSV data.", error.message);
                         addMessageToChat("Sorry, I couldn't parse the data file. Please check the console for details.", 'assistant');
                    }
                });
            })
            .catch(error => {
                handleError("Could not fetch or process the data file.", error);
                addMessageToChat("Sorry, I couldn't load the necessary data. Please ensure 'assam_flood_data_v2.csv' exists, is accessible, and has the correct headers.", 'assistant');
            });
    }

    // =========================================================================
    // User Input Handling
    // =========================================================================

    function handleUserInput() {
        const userText = userInput.value.trim();

        if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY') {
            addMessageToChat("⚠️ Gemini API key is not configured in script.js. Please add your key.", 'assistant');
            console.error("Gemini API key missing or placeholder detected.");
            return;
        }
        if (allData.length === 0) {
            addMessageToChat("⚠️ Data hasn't loaded correctly. Please check the console and ensure the CSV file is present.", 'assistant');
            return;
        }
        if (userText === "") return;

        addMessageToChat(userText, 'user');
        // Add user message to conversation history *before* sending to LLM
        conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
        userInput.value = "";
        setLoadingState(true);

        // Process the query to get filter criteria
        getFiltersFromLLM(userText);
    }

    // =========================================================================
    // LLM Interaction - Focused on Filter Extraction and Contextual Response
    // =========================================================================

    /**
     * Asks the LLM to extract filter criteria from the user query.
     * @param {string} query - The user's current query text.
     */
    async function getFiltersFromLLM(query) {
        const dataFieldsString = validCsvHeaders.join(', ');

        // --- Refined Prompt - Focused on JSON Output ---
        const systemInstruction = `You are an AI assistant analyzing flood and landslide data from a CSV file for Assam, India.
Your ONLY task is to interpret the user's query and generate a JSON object representing the filter criteria based on the available data fields.
Available data fields: ${dataFieldsString}.

Guidelines:
1. Analyze the user's query and the recent conversation history.
2. Identify relevant filtering conditions (district, year, month, severity, risk levels, rainfall ranges, etc.).
3. Map user terms to data fields:
    - "High/Severe flood" or "major flood" likely maps to \`"FloodSeverity": "High"\` or \`"FloodSeverity": "Severe"\`. If unsure between High/Severe, you can include both in an array like \`"FloodSeverity": ["High", "Severe"]\` or just pick "Severe".
    - "High landslide risk" maps to \`"LandslideRisk": "High"\`.
    - "High flood risk forecast" maps to \`"FloodRiskForecast": "High"\`.
    - Month names (e.g., "July", "aug") MUST be converted to numbers (1-12), like \`"Month": "7"\` or \`"Month": "8"\`.
    - Specific locations might map to \`"LocationName"\` or \`"District"\`. Prefer \`"District"\` if mentioned generally.
    - Rainfall conditions (e.g., "rainfall above 500mm") should be noted, but direct range filtering (> / <) in JSON is complex for the current data structure; focus on extracting the number if possible, like \`"MonthlyRainfall_mm": "500"\` and the relation ("above", "below"). We will handle the comparison logic later.
    - Extract the Year if mentioned (e.g., \`"Year": "2023"\`).
4. Output FORMAT: Respond ONLY with a single JSON object containing the extracted criteria.
    - Example Query: "show severe floods in Sivasagar during July 2023" -> Expected JSON Output: \`{"District": "Sivasagar", "FloodSeverity": "Severe", "Year": "2023", "Month": "7"}\`
    - Example Query: "high landslide risk in Dima Hasao" -> Expected JSON Output: \`{"District": "Dima Hasao", "LandslideRisk": "High"}\`
    - Example Query: "rainfall above 500 mm in 2022" -> Expected JSON Output: \`{"Year": "2022", "MonthlyRainfall_mm": "500", "RainfallCondition": "above"}\`
5. If the query is too vague, unclear, or you cannot confidently extract filters, output an empty JSON object: \`{}\`.
6. DO NOT add any conversational text, greetings, explanations, or markdown formatting (like \`\`\`json) around the JSON output. Just the raw JSON object.

Current Conversation History (for context):
${JSON.stringify(conversationHistory.slice(-4))}
`; // Include last few turns for context

        const promptPayload = {
            // Note: Gemini 1.5 Pro API structure uses 'contents' array directly
            contents: [
                // Provide context and instructions clearly
                { role: "user", parts: [{ text: systemInstruction }] },
                { role: "model", parts: [{ text: "{}" }] }, // Prime the model for JSON output
                // Add the actual user query
                { role: "user", parts: [{ text: query }] }
            ],
            generationConfig: {
                temperature: 0.2, // Lower temperature for more deterministic JSON extraction
                maxOutputTokens: 200, // Limit output size, JSON shouldn't be huge
                // responseMimeType: "application/json" // Can try this if API supports forcing JSON output
            },
            safetySettings: [ // Standard safety settings
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
            ]
        };

        try {
            console.log("Sending to Gemini API for filter extraction:", JSON.stringify(promptPayload, null, 2));
            const response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(promptPayload)
            });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error("Gemini API Error Response Body:", errorBody);
                throw new Error(`Gemini API request failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            console.log("Received from Gemini API:", JSON.stringify(data, null, 2));

            let rawLLMText = "";
            if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
                 rawLLMText = data.candidates[0].content.parts[0].text.trim();
            } else {
                 throw new Error("Received unexpected response format from AI service.");
            }

            // --- Process the LLM response (expecting JSON) ---
            let filterCriteria = {};
            let responseMessage = "";

            try {
                // Attempt to parse the entire response as JSON
                filterCriteria = JSON.parse(rawLLMText);
                console.log("Successfully parsed JSON criteria:", filterCriteria);

                if (Object.keys(filterCriteria).length > 0) {
                    // Apply filters and generate response
                    const filteredData = filterData(filterCriteria);
                    displayDataOnMap(filteredData);

                    if (filteredData.length > 0) {
                        // Generate both a map notification and a contextual response
                        const mapNotification = `Showing ${filteredData.length} location(s) on the map matching your criteria for ${generateCriteriaSummary(filterCriteria)}.`;
                        
                        // Generate contextual response based on the filtered data
                        const contextualResponse = generateContextualResponse(query, filteredData, filterCriteria);
                        
                        // Combine both responses
                        responseMessage = `${contextualResponse}\n\n${mapNotification}`;
                    } else {
                        responseMessage = `I understood the criteria (${generateCriteriaSummary(filterCriteria)}), but found no matching data points in the records.`;
                    }
                } else {
                    // LLM returned {} - indicating clarification needed
                    responseMessage = "I couldn't determine specific filters from your request. Could you please provide more details like the year, district, severity level, or month?";
                    markersLayer.clearLayers(); // Clear map if clarification needed
                }

            } catch (parseError) {
                console.error("Failed to parse LLM response as JSON:", parseError);
                console.warn("LLM raw response:", rawLLMText);
                // Handle non-JSON response - maybe LLM didn't follow instructions
                responseMessage = "Sorry, I had trouble understanding the specific criteria for filtering. Could you please rephrase your request? (Received non-JSON response from AI)";
                 markersLayer.clearLayers(); // Clear map on error/confusion
            }

            // Add assistant's response to chat and history
            addMessageToChat(responseMessage, 'assistant');
            
            // Only speak the response if the input was voice
            if (lastInputWasVoice) {
                speakText(responseMessage);
            }
            
            conversationHistory.push({ role: 'model', parts: [{ text: responseMessage }] }); // Add the final assistant response

        } catch (error) {
            handleError("Error processing query with AI.", error);
            const errorMsg = "Sorry, I encountered an issue trying to understand that. Please try again.";
            addMessageToChat(errorMsg, 'assistant');
            
            // Only speak errors if the input was voice
            if (lastInputWasVoice) {
                speakText(errorMsg);
            }
            
            // Add error indication to history
            conversationHistory.push({ role: 'model', parts: [{ text: `(Error: ${error.message})` }] });
        } finally {
            setLoadingState(false);
             // Clean up history (optional: limit length)
             if (conversationHistory.length > 10) {
                 conversationHistory = conversationHistory.slice(-10); // Keep last 5 turns
             }
        }
    }

    /**
     * Generates a contextual response based on filtered data and user query
     * @param {string} query - The original user query
     * @param {Array} filteredData - The filtered data array
     * @param {Object} criteria - The filter criteria
     * @returns {string} - A contextual response
     */
    function generateContextualResponse(query, filteredData, criteria) {
        // Default simple response
        let response = `I found ${filteredData.length} relevant location(s).`;
        
        // Extract key information about affected population
        if (query.toLowerCase().includes("population") || query.toLowerCase().includes("affected")) {
            let totalAffected = 0;
            let maxAffected = 0;
            let worstHitDistrict = "";
            let districts = new Set();
            
            // Calculate statistics
            filteredData.forEach(record => {
                const affected = parseInt(record.AffectedPopulation_Est) || 0;
                totalAffected += affected;
                districts.add(record.District);
                
                if (affected > maxAffected) {
                    maxAffected = affected;
                    worstHitDistrict = record.District;
                }
            });
            
            // Format the response
            response = `Based on the data, approximately ${totalAffected.toLocaleString()} people were affected`;
            
            if (criteria.Year) response += ` in ${criteria.Year}`;
            if (criteria.Month) {
                const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                const monthIndex = parseInt(criteria.Month) - 1;
                if (monthIndex >= 0 && monthIndex < 12) {
                    response += ` during ${monthNames[monthIndex]}`;
                }
            }
            
            if (criteria.District) {
                response += ` in ${criteria.District} district`;
            } else if (districts.size > 0) {
                response += ` across ${districts.size} districts in Assam`;
                if (worstHitDistrict) {
                    response += `, with ${worstHitDistrict} being the worst affected (${maxAffected.toLocaleString()} people)`;
                }
            }
            
            response += ".";
        }
        
        // Extract information about rainfall
        else if (query.toLowerCase().includes("rain") || query.toLowerCase().includes("rainfall")) {
            let totalRainfall = 0;
            let maxRainfall = 0;
            let minRainfall = Infinity;
            let highestRainfallLocation = "";
            let validRecords = 0;
            
            // Calculate statistics
            filteredData.forEach(record => {
                const rainfall = parseFloat(record.MonthlyRainfall_mm) || 0;
                if (rainfall > 0) {
                    totalRainfall += rainfall;
                    validRecords++;
                    
                    if (rainfall > maxRainfall) {
                        maxRainfall = rainfall;
                        highestRainfallLocation = record.LocationName || record.District;
                    }
                    
                    if (rainfall < minRainfall) {
                        minRainfall = rainfall;
                    }
                }
            });
            
            // Format the response
            if (validRecords > 0) {
                const avgRainfall = totalRainfall / validRecords;
                response = `The average rainfall was ${avgRainfall.toFixed(1)} mm`;
                
                if (criteria.Year) response += ` in ${criteria.Year}`;
                if (criteria.Month) {
                    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                    const monthIndex = parseInt(criteria.Month) - 1;
                    if (monthIndex >= 0 && monthIndex < 12) {
                        response += ` during ${monthNames[monthIndex]}`;
                    }
                }
                
                if (criteria.District) {
                    response += ` in ${criteria.District}`;
                }
                
                response += `. The highest recorded rainfall was ${maxRainfall.toFixed(1)} mm in ${highestRainfallLocation}.`;
            } else {
                response = `I found ${filteredData.length} locations matching your query, but rainfall data is unavailable.`;
            }
        }
        
        // Extract information about flood severity
        else if (query.toLowerCase().includes("flood") || query.toLowerCase().includes("severe")) {
            const severityCounts = {
                "Severe": 0,
                "High": 0,
                "Medium": 0,
                "Low": 0,
                "None": 0
            };
            
            // Count by severity
            filteredData.forEach(record => {
                const severity = record.FloodSeverity;
                if (severity && severityCounts.hasOwnProperty(severity)) {
                    severityCounts[severity]++;
                }
            });
            
            // Format the response
            response = `I found ${filteredData.length} flood records`;
            
            if (criteria.Year) response += ` from ${criteria.Year}`;
            if (criteria.Month) {
                const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                const monthIndex = parseInt(criteria.Month) - 1;
                if (monthIndex >= 0 && monthIndex < 12) {
                    response += ` in ${monthNames[monthIndex]}`;
                }
            }
            
            if (criteria.District) {
                response += ` for ${criteria.District}`;
            }
            
            // Include severity breakdown if we have that data
            const severeCount = severityCounts["Severe"] + severityCounts["High"];
            if (severeCount > 0) {
                response += `. Of these, ${severeCount} were classified as severe or high severity floods.`;
            } else {
                response += ".";
            }
        }
        
        // Extract information about landslides
        else if (query.toLowerCase().includes("landslide")) {
            let totalLandslides = 0;
            let highRiskLocations = 0;
            
            // Calculate statistics
            filteredData.forEach(record => {
                const landslideCount = parseInt(record.LandslideCount_Reported) || 0;
                totalLandslides += landslideCount;
                
                if (record.LandslideRisk === "High") {
                    highRiskLocations++;
                }
            });
            
            // Format the response
            response = `I found data on ${totalLandslides} reported landslides`;
            
            if (criteria.Year) response += ` in ${criteria.Year}`;
            if (criteria.Month) {
                const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                const monthIndex = parseInt(criteria.Month) - 1;
                if (monthIndex >= 0 && monthIndex < 12) {
                    response += ` during ${monthNames[monthIndex]}`;
                }
            }
            
            if (criteria.District) {
                response += ` in ${criteria.District}`;
            }
            
            if (highRiskLocations > 0) {
                response += `. There are ${highRiskLocations} locations classified as high landslide risk areas.`;
            } else {
                response += ".";
            }
        }
        
        // Generic response for other types of queries
        else {
            const districts = new Set(filteredData.map(record => record.District));
            response = `I found ${filteredData.length} records matching your criteria`;
            
            if (criteria.Year) response += ` from ${criteria.Year}`;
            if (criteria.Month) {
                const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                const monthIndex = parseInt(criteria.Month) - 1;
                if (monthIndex >= 0 && monthIndex < 12) {
                    response += ` in ${monthNames[monthIndex]}`;
                }
            }
            
            if (districts.size > 0 && districts.size < 5) {
                response += ` across ${Array.from(districts).join(", ")}`;
            } else if (districts.size >= 5) {
                response += ` across ${districts.size} districts in Assam`;
            }
            
            response += ".";
        }
        
        return response;
    }

    // =========================================================================
    // Data Filtering Logic
    // =========================================================================

    /**
     * Filters the global `allData` array based on criteria object.
     * @param {object} criteria - The filter criteria (e.g., {District: "Sivasagar", Year: "2023"}).
     * @returns {Array} - The filtered data array.
     */
    function filterData(criteria) {
        if (!criteria || Object.keys(criteria).length === 0 || allData.length === 0) {
            return [];
        }
        console.log("Applying filters:", criteria);

        const monthMap = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

        // Extract potential range conditions (simple implementation)
        const rainfallCriteria = criteria.MonthlyRainfall_mm;
        const rainfallCondition = criteria.RainfallCondition?.toLowerCase(); // 'above', 'below'

        return allData.filter(item => {
            for (const key in criteria) {
                // Skip the helper condition key
                if (key === 'RainfallCondition') continue;

                if (!item.hasOwnProperty(key)) {
                    console.warn(`Data item missing expected filter key: ${key}. RecordID: ${item.RecordID}`);
                    return false;
                }

                const itemValue = item[key]?.toString().trim() || "";
                let criteriaValue = criteria[key]; // Can be string or array

                // --- Handle Array Criteria (e.g., FloodSeverity: ["High", "Severe"]) ---
                if (Array.isArray(criteriaValue)) {
                    const itemValueLower = itemValue.toLowerCase();
                    const match = criteriaValue.some(cv => itemValueLower.includes(cv?.toString().toLowerCase()));
                    if (!match) return false; // Item value must match at least one in the array
                }
                // --- Handle String Criteria ---
                else {
                    const itemValueLower = itemValue.toLowerCase();
                    const criteriaValueStr = criteriaValue?.toString().trim().toLowerCase() || "";

                    if (criteriaValueStr === "") continue; // Skip empty criteria

                    // Special handling for Month
                    if (key.toLowerCase() === 'month') {
                        const criteriaMonthNum = monthMap[criteriaValueStr] || parseInt(criteriaValueStr, 10);
                        const itemMonthNum = parseInt(itemValueLower, 10);
                        if (isNaN(criteriaMonthNum) || isNaN(itemMonthNum) || itemMonthNum !== criteriaMonthNum) {
                            return false;
                        }
                    }
                    // Special handling for Rainfall (simple > / <)
                    else if (key === 'MonthlyRainfall_mm' && rainfallCondition && rainfallCriteria) {
                        const itemRainfall = parseFloat(itemValue);
                        const criteriaRainfall = parseFloat(rainfallCriteria);
                        if (isNaN(itemRainfall) || isNaN(criteriaRainfall)) {
                            return false; // Cannot compare if not numbers
                        }
                        if (rainfallCondition === 'above' && !(itemRainfall > criteriaRainfall)) {
                            return false;
                        }
                        if (rainfallCondition === 'below' && !(itemRainfall < criteriaRainfall)) {
                            return false;
                        }
                        // If condition matches, don't return true yet, other criteria must also match
                    }
                    // General comparison (case-insensitive substring match)
                    else if (!itemValueLower.includes(criteriaValueStr)) {
                        return false;
                    }
                }
            }
            return true; // All criteria matched
        });
    }

    /** Helper to create a human-readable summary of filters */
    function generateCriteriaSummary(criteria) {
        const parts = [];
        for (const key in criteria) {
            if (key === 'RainfallCondition') continue; // Skip helper
            let value = criteria[key];
            if(Array.isArray(value)) value = value.join('/'); // Format array values
            parts.push(`${key}: ${value}`);
        }
        // Add rainfall condition description if present
        if (criteria.RainfallCondition && criteria.MonthlyRainfall_mm) {
            parts.push(`Rainfall ${criteria.RainfallCondition} ${criteria.MonthlyRainfall_mm}mm`);
        }
        return parts.join(', ');
    }

    // =========================================================================
    // Mapping Functions (Leaflet)
    // =========================================================================

    function getMarkerColor(record) {
        const severity = record.FloodSeverity?.toLowerCase();
        const landslideRisk = record.LandslideRisk?.toLowerCase();

        if (severity === 'severe') return 'darkred';
        if (severity === 'high') return 'red';
        if (severity === 'medium') return 'orange';
        if (severity === 'low') return 'gold';
        if (severity === 'none' || !severity) {
            if (landslideRisk === 'high') return 'purple';
            if (landslideRisk === 'medium') return 'darkblue';
            return '#28a745'; // Green for low/no risk
        }
        return 'grey'; // Default fallback
    }

    function createCustomIcon(color, hasLandslide) {
        const markerHtmlStyles = `
            background-color: ${color}; width: 1.8rem; height: 1.8rem; display: block;
            left: -0.9rem; top: -0.9rem; position: relative; border-radius: 50% 50% 50% 0;
            transform: rotate(-45deg); border: 1px solid #FFFFFF; box-shadow: 2px 2px 5px rgba(0,0,0,0.5);
            text-align: center; line-height: 1.8rem; font-size: 0.9rem; font-weight: bold;
            color: ${color === 'gold' || color === '#28a745' ? 'black' : 'white'}; transform-origin: center center;`;
        const landslideIndicator = hasLandslide ? `<span style="transform: rotate(45deg); display: inline-block; margin-top: -2px;">L</span>` : '';
        return L.divIcon({
            className: "custom-pin", iconAnchor: [0, 15], popupAnchor: [0, -18],
            html: `<span style="${markerHtmlStyles}">${landslideIndicator}</span>`
        });
    }

    function displayDataOnMap(dataToDisplay) {
        markersLayer.clearLayers();
        if (!dataToDisplay || dataToDisplay.length === 0) {
            console.log("No data to display on the map.");
            // Optional: Reset map view if nothing is displayed
            // map.setView([26.2006, 92.9376], 7);
            return;
        }

        const bounds = L.latLngBounds();
        let displayedCount = 0;

        dataToDisplay.forEach(item => {
            const lat = parseFloat(item.Latitude);
            const lon = parseFloat(item.Longitude);

            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                const color = getMarkerColor(item);
                const hasLandslide = parseInt(item.LandslideCount_Reported || 0) > 0;
                const marker = L.marker([lat, lon], {
                    icon: createCustomIcon(color, hasLandslide),
                    title: `${item.LocationName || 'Location'}, ${item.District} (${item.Month}/${item.Year})`
                });

                const popupContent = `
                    <div class="popup-content">
                        <b>${item.LocationName || 'N/A'}, ${item.District || 'N/A'}</b>
                        <b>Period:</b> ${item.Month || '?'}/${item.Year || '?'}<br>
                        <b>Rainfall:</b> ${item.MonthlyRainfall_mm || 'N/A'} mm<br>
                        <b>River:</b> ${item.MainRiver || 'N/A'} (<span style="font-weight: bold; color:${getRiverLevelColor(item.RiverLevel)}">${item.RiverLevel || 'N/A'}</span>)<br>
                        <b>Flood Severity:</b> <span style="font-weight: bold; color:${getSeverityColor(item.FloodSeverity)}">${item.FloodSeverity || 'N/A'}</span><br>
                        <b>Affected Pop. (Est):</b> ${item.AffectedPopulation_Est || 'N/A'}<br>
                        <b>Landslides Reported:</b> ${item.LandslideCount_Reported || '0'}<br>
                        <b>Landslide Risk:</b> <span style="font-weight: bold; color:${getRiskColor(item.LandslideRisk)}">${item.LandslideRisk || 'N/A'}</span><br>
                        <b>Flood Risk Forecast:</b> <span style="font-weight: bold; color:${getRiskColor(item.FloodRiskForecast)}">${item.FloodRiskForecast || 'N/A'}</span><br>
                        <b>Data Source:</b> ${item.DataSource || 'N/A'}
                    </div>`;
                marker.bindPopup(popupContent);
                marker.addTo(markersLayer);
                bounds.extend([lat, lon]);
                displayedCount++;
            } else {
                console.warn("Invalid Lat/Lon for RecordID:", item.RecordID);
            }
        });

        if (bounds.isValid()) {
            setTimeout(() => { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 }); }, 100);
        } else if (displayedCount === 1) {
            const singlePoint = dataToDisplay.find(item => !isNaN(parseFloat(item.Latitude)));
            if (singlePoint) map.setView([parseFloat(singlePoint.Latitude), parseFloat(singlePoint.Longitude)], 10);
        }
        console.log(`Displayed ${displayedCount} markers.`);
    }

    // Popup color helpers
    function getSeverityColor(severity) {
        switch (severity?.toLowerCase()) {
            case 'severe': return 'darkred'; case 'high': return 'red';
            case 'medium': return 'orange'; case 'low': return 'darkgoldenrod';
            case 'none': return 'green'; default: return 'black';
        }
    }
    function getRiskColor(risk) {
        switch (risk?.toLowerCase()) {
            case 'high': return 'purple'; case 'medium': return 'darkblue';
            case 'low': return 'green'; default: return 'black';
        }
    }
    function getRiverLevelColor(level) {
        switch (level?.toLowerCase()) {
            case 'danger': return 'darkred'; case 'warning': return 'red';
            case 'above normal': return 'orange'; case 'normal': return 'green';
            case 'below normal': return 'blue'; default: return 'black';
        }
    }

    // =========================================================================
    // UI & Helper Functions
    // =========================================================================

    function addMessageToChat(message, sender) {
        const messageElement = document.createElement('div');
        // Use 'assistant' for bot messages for clarity, keep 'user' for user
        const senderClass = sender === 'user' ? 'user-message' : 'bot-message';
        messageElement.classList.add(senderClass);
        
        // For multiline messages with \n, preserve line breaks
        if (message.includes('\n')) {
            const paragraphs = message.split('\n').filter(p => p.trim() !== '');
            
            paragraphs.forEach((paragraph, index) => {
                // Basic sanitation
                const sanitizedText = paragraph.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                
                // Create a paragraph element for each line
                const p = document.createElement('p');
                p.innerHTML = sanitizedText;
                
                // Add margin only between paragraphs
                if (index < paragraphs.length - 1) {
                    p.style.marginBottom = '8px';
                }
                
                messageElement.appendChild(p);
            });
        } else {
            // Basic sanitation for single line messages
            messageElement.textContent = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
        
        chatbox.appendChild(messageElement);
        chatbox.scrollTop = chatbox.scrollHeight;
    }

    function setLoadingState(isLoading) {
        userInput.disabled = isLoading;
        sendButton.disabled = isLoading;
        voiceButton.disabled = isLoading || !window.SpeechRecognition;
        loadingIndicator.style.display = isLoading ? 'inline' : 'none';
    }

    function handleError(userMessage, error) {
        console.error(userMessage, error);
        // Don't add technical errors directly to chat unless debugging
        // addMessageToChat(`Error: ${userMessage} - ${error.message || error}`, 'assistant-error');
        setLoadingState(false);
    }

    // =========================================================================
    // Speech Recognition (Web Speech API)
    // =========================================================================
    function setupSpeechRecognition() {
        window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!window.SpeechRecognition) {
            voiceButton.disabled = true;
            voiceButton.title = "Speech Recognition not supported.";
            console.warn("Speech Recognition API not supported.");
            return;
        }
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.lang = 'en-IN'; // Changed to Indian English
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
            const speechResult = event.results[0][0].transcript;
            userInput.value = speechResult;
            stopRecognitionVisuals();
            
            // Set flag to indicate voice input was used
            lastInputWasVoice = true;
            
            handleUserInput(); // Trigger processing
        };
        recognition.onspeechend = () => stopRecognitionVisuals();
        recognition.onnomatch = () => {
            addMessageToChat("Sorry, I didn't catch that. Could you try again?", 'assistant');
            speakText("Sorry, I didn't catch that. Could you try again?");
            stopRecognitionVisuals();
        };
        recognition.onerror = (event) => {
            console.error('Speech Recognition Error:', event.error, event.message);
            let errorMsg = `Speech recognition error: ${event.error}.`;
            if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                errorMsg = "Microphone access denied. Please enable microphone permissions.";
            } else if (event.error === 'no-speech') {
                errorMsg = "No speech detected. Microphone working?";
            }
            addMessageToChat(errorMsg, 'assistant');
            speakText(errorMsg);
            stopRecognitionVisuals();
        };
        recognition.onend = () => stopRecognitionVisuals(); // Ensure reset
    }

    function toggleVoiceRecognition() {
        if (!recognition) return;
        if (isRecognizing) {
            recognition.stop();
        } else {
            if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY') {
                addMessageToChat("⚠️ Please configure the Gemini API key before using voice input.", 'assistant');
                return;
            }
            if (allData.length === 0) {
                addMessageToChat("⚠️ Data not loaded, cannot process voice input.", 'assistant');
                return;
            }
            try {
                recognition.start();
                isRecognizing = true;
                voiceButton.textContent = '🛑'; voiceButton.title = "Stop Voice Input";
                voiceButton.style.backgroundColor = 'red';
            } catch (e) {
                console.error("Error starting voice recognition:", e);
                stopRecognitionVisuals(); // Reset on immediate error
            }
        }
    }

    function stopRecognitionVisuals() {
        isRecognizing = false;
        voiceButton.textContent = '🎤'; voiceButton.title = "Start Voice Input";
        voiceButton.style.backgroundColor = '#6c757d';
    }

    // =========================================================================
    // Speech Synthesis (Web Speech API)
    // =========================================================================
    function speakText(textToSpeak) {
        if (!window.speechSynthesis) {
            console.warn("Speech Synthesis API not supported.");
            return;
        }
        
        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }
        
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = 'en-IN'; // Changed to Indian English
        utterance.rate = 1.0;
        
        // Set a timer to load available voices
        setTimeout(() => {
            // Try to find an Indian English female voice
            const voices = speechSynthesis.getVoices();
            console.log("Available voices:", voices.map(v => `${v.name} (${v.lang})`));
            
            // Search for Indian English female voice
            const indianFemaleVoice = voices.find(voice => 
                (voice.lang === 'en-IN' || voice.lang === 'hi-IN') && 
                voice.name.toLowerCase().includes('female')
            );
            
            // If Indian female voice not found, try any Indian voice
            const indianVoice = indianFemaleVoice || 
                                voices.find(voice => voice.lang === 'en-IN') ||
                                voices.find(voice => voice.lang === 'hi-IN');
            
            // If any Indian voice not found, try any English female voice
            const englishFemaleVoice = indianVoice || 
                                      voices.find(voice => 
                                          voice.lang.startsWith('en-') && 
                                          voice.name.toLowerCase().includes('female')
                                      );
            
            // Set the voice if found, otherwise use default
            if (indianFemaleVoice) {
                console.log("Using Indian female voice:", indianFemaleVoice.name);
                utterance.voice = indianFemaleVoice;
            } else if (indianVoice) {
                console.log("Using Indian voice:", indianVoice.name);
                utterance.voice = indianVoice;
            } else if (englishFemaleVoice) {
                console.log("Using English female voice:", englishFemaleVoice.name);
                utterance.voice = englishFemaleVoice;
            } else {
                console.log("No suitable voice found, using default");
            }
            
            utterance.onerror = (event) => console.error('Speech Synthesis Error:', event.error);
            utterance.onend = () => console.log('Speech Synthesis finished.');
            
            // Split long text into sentences for better speech synthesis
            // This helps prevent cutting off in some browsers
            if (textToSpeak.length > 200) {
                const sentences = textToSpeak.match(/[^.!?]+[.!?]+/g) || [textToSpeak];
                let i = 0;
                
                const speakNextSentence = () => {
                    if (i < sentences.length) {
                        const sentenceUtterance = new SpeechSynthesisUtterance(sentences[i]);
                        sentenceUtterance.lang = utterance.lang;
                        sentenceUtterance.voice = utterance.voice;
                        sentenceUtterance.rate = utterance.rate;
                        
                        sentenceUtterance.onend = () => {
                            i++;
                            speakNextSentence();
                        };
                        
                        speechSynthesis.speak(sentenceUtterance);
                    }
                };
                
                speakNextSentence();
            } else {
                speechSynthesis.speak(utterance);
            }
        }, 100); // Wait for voices to load
    }

}); // End DOMContentLoaded
