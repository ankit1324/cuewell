const fs = require('fs');
const path = require('path');

// Interview modes, in toolbar cycle order. The id is the active-skill setting
// and the prompt file name (prompts/<id>.md). 'auto' is the default and
// answers any question in the format that fits it; the others force a
// format. 'dsa' is kept as Coding's id for compatibility.
const MODES = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Auto', usesLanguage: true }),
  Object.freeze({ id: 'dsa', label: 'Coding', usesLanguage: true }),
  Object.freeze({ id: 'technical', label: 'Technical', usesLanguage: false }),
  Object.freeze({ id: 'system-design', label: 'System design', usesLanguage: false }),
  Object.freeze({ id: 'behavioral', label: 'Behavioral', usesLanguage: false }),
  Object.freeze({ id: 'hr', label: 'HR', usesLanguage: false })
]);
const DEFAULT_MODE = 'auto';
const MODE_IDS = MODES.map((mode) => mode.id);

// Answer length setting. 'auto' is Short for voice and Standard otherwise.
const ANSWER_LENGTHS = Object.freeze(['auto', 'short', 'standard', 'detailed']);

const LENGTH_RULES = {
  short: 'short. After the first line, at most 3-5 tight bullets or sentences (roughly 60-120 words of prose; a behavioral story about 60 seconds spoken). Code, when needed, is still complete and runnable.',
  standard: 'standard. After the first line, a focused answer of roughly 150-300 words of prose (a behavioral story 60-90 seconds spoken), plus any code.',
  detailed: 'detailed. After the first line, a thorough answer with reasoning, examples, edge cases and trade-offs (a behavioral story up to 90 seconds spoken, then likely follow-ups with short answers).'
};

// Interview context (profile.json) fields as they appear in the prompt.
const PROFILE_PROMPT_FIELDS = [
  { key: 'role', label: 'Target role', block: false },
  { key: 'company', label: 'Company', block: false },
  { key: 'jobDescription', label: 'Job description', block: true },
  { key: 'resume', label: 'Resume', block: true },
  { key: 'notes', label: "Candidate's notes (follow these as preferences)", block: true }
];

// About you (profile.json) choice values as they appear in the prompt.
// Looked up with ownValue so a value such as "constructor" matches nothing.
const RELOCATION_TEXT = { yes: 'yes', no: 'no', maybe: 'maybe, open to discussing it' };
const TONE_RULES = {
  confident: 'confident. Sound assured and direct, with no hedging, apologies or filler.',
  friendly: 'friendly. Sound warm and conversational while staying professional.',
  formal: 'formal. Sound polished and professional, with no slang or casual phrases.',
  concise: 'concise. Use the fewest words that still answer fully; cut every extra phrase.'
};
const ownValue = (map, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '');

// About you > Answer in "Hinglish (Roman script)": how Indian candidates
// mix Hindi and English in interviews, written in Latin letters only.
const HINGLISH_RULE = '- Language: write every answer in natural Hinglish, the mix of Hindi and English that Indian candidates speak in interviews, including the first line, even when the question is in another language. Write it only in Roman (Latin) script, never in Devanagari or any other script, for example: "Haan, main is approach ko explain karta hoon. Time complexity O(n log n) hai." Keep technical terms, names, identifiers and complexity notation such as O(n log n) in English. Code blocks stay exactly as they would in an English answer, comments included.';

class PromptLoader {
  constructor() {
    this.prompts = new Map();
    this.promptsLoaded = false;
    this.skillPromptSent = new Set();
    this.skillsRequiringProgrammingLanguage = MODES.filter((m) => m.usesLanguage).map((m) => m.id);
  }

  /**
   * Load all skill prompts from the prompts directory
   */
  loadPrompts() {
    if (this.promptsLoaded) {
      return;
    }

    // In packaged builds asar-unpacked files are still reachable through
    // their original path thanks to Electron's fs patching.
    const promptsDir = path.join(__dirname, 'prompts');
    
    try {
      const files = fs.readdirSync(promptsDir);
      
      for (const file of files) {
        if (file.endsWith('.md')) {
          const skillName = path.basename(file, '.md');
          if (!MODE_IDS.includes(skillName)) continue; // only interview modes
          const filePath = path.join(promptsDir, file);
          const promptContent = fs.readFileSync(filePath, 'utf8');
          
          this.prompts.set(skillName, promptContent);
        }
      }
      
      this.promptsLoaded = true;
      
    } catch (error) {
      console.error('Error loading skill prompts:', error);
      throw new Error(`Failed to load skill prompts: ${error.message}`);
    }
  }

  /**
   * Get the system prompt for a specific skill with optional programming language injection
   * @param {string} skillName - The name of the skill
   * @param {string|null} programmingLanguage - Optional programming language to inject
   * @returns {string|null} The system prompt content or null if not found
   */
  getSkillPrompt(skillName, programmingLanguage = null) {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    const normalizedSkillName = this.normalizeSkillName(skillName);
    let promptContent = this.prompts.get(normalizedSkillName);
    
    if (!promptContent) {
      return null;
    }

    // Inject programming language if provided and skill requires it
    if (programmingLanguage && this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName)) {
      promptContent = this.injectProgrammingLanguage(promptContent, programmingLanguage, normalizedSkillName);
    }

    return promptContent;
  }

  /**
   * Inject programming language context into skill prompts
   * @param {string} promptContent - Original prompt content
   * @param {string} programmingLanguage - Programming language to inject
   * @param {string} skillName - Normalized skill name
   * @returns {string} Modified prompt with programming language context
   */
  injectProgrammingLanguage(promptContent, programmingLanguage, skillName) {
    const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript' };
    const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
    const norm = (programmingLanguage || '').toLowerCase();
    const languageTitle = languageMap[norm] || (programmingLanguage.charAt(0).toUpperCase() + programmingLanguage.slice(1));
    const fenceTag = fenceTagMap[norm] || norm || 'text';
    const languageUpper = (languageMap[norm] || languageTitle).toUpperCase();
    
    let languageInjection = '';
    
    switch (skillName) {
      case 'auto':
        languageInjection = `\n\n## CODING LANGUAGE (internal, never mention this setting): ${languageUpper}
- When a question needs code (a coding or DSA problem, or "write a function..."), write it ONLY in ${languageTitle}, in a block tagged \`\`\`${fenceTag}\`\`\`, aiming for optimal time and space complexity.
- For coding problems without code in the question, give a complete, runnable ${languageTitle} solution without asking for clarification.
- When a theory question is about another language or tool (TypeScript, SQL, Bash, ...), its small example may use that language. Never add code to answers that do not need it.`;
        break;
      case 'dsa':
        languageInjection = `\n\n## IMPLEMENTATION LANGUAGE (internal, never mention this setting): ${languageUpper}
STRICT REQUIREMENTS:
- Respond ONLY in ${languageTitle}. Do not include any snippets or alternatives in other languages.
- All code blocks must use triple backticks with the exact language tag: \`\`\`${fenceTag}\`\`\`.
- Aim for the best possible time and space complexity; prefer optimal algorithms and data structures.
- Provide: brief approach, then final ${languageTitle} implementation, followed by time/space complexity.
- If the user's input is a problem statement (and does not include code), produce a complete, runnable ${languageTitle} solution without asking for clarification.
- Avoid unnecessary verbosity; focus on correctness, clarity, and efficiency.`;
        break;
      default:
        languageInjection = `\n\n## PROGRAMMING LANGUAGE (internal, never mention this setting): ${languageUpper}\nAll code and examples must be in ${languageTitle}. Use code fences with tag: \`\`\`${fenceTag}\`\`\`.`;
    }

    return promptContent + languageInjection;
  }

  /**
   * Check if stored memory is empty (first time interaction)
   * @param {Array} storedMemory - Current stored memory from your system
   * @returns {boolean} True if memory is empty
   */
  isFirstTimeInteraction(storedMemory) {
    return !storedMemory || storedMemory.length === 0;
  }

  /**
   * Check if skill prompt should be sent as model memory
   * @param {string} skillName - The name of the skill
   * @param {Array} storedMemory - Current stored memory
   * @returns {boolean} True if skill prompt should be sent as model memory
   */
  shouldSendAsModelMemory(skillName, storedMemory) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    
    // If stored memory is empty, this is the first time - send as model memory
    if (this.isFirstTimeInteraction(storedMemory)) {
      return true;
    }

    // Check if we've already sent this skill's prompt as model memory
    const hasSkillInMemory = storedMemory.some(event => 
      event.skillUsed === normalizedSkillName && event.promptSentAsMemory === true
    );

    if (!hasSkillInMemory) {
      return true;
    }

    return false;
  }

  /**
   * Prepare Gemini API request with model memory or regular message
   * @param {string} skillName - The active skill
   * @param {string} userMessage - The user's message/query
   * @param {Array} storedMemory - Current stored memory
   * @param {string|null} programmingLanguage - Optional programming language
   * @returns {Object} Gemini API request configuration
   */
  prepareGeminiRequest(skillName, userMessage, storedMemory, programmingLanguage = null) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const skillPrompt = this.getSkillPrompt(normalizedSkillName, programmingLanguage);
    
    const requestConfig = {
      model: 'gemini-pro', // or your preferred Gemini model
      contents: [],
      systemInstruction: null,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      }
    };

    // If stored memory is empty or skill prompt not sent, use model memory
    if (this.shouldSendAsModelMemory(skillName, storedMemory)) {
      if (skillPrompt) {
        // Send skill prompt as system instruction (model memory)
        requestConfig.systemInstruction = {
          parts: [{ text: skillPrompt }]
        };
        
        // Add user message as regular content
        requestConfig.contents.push({
          role: 'user',
          parts: [{ text: userMessage }]
        });
        
        // Mark that we're sending this as model memory
        this.skillPromptSent.add(normalizedSkillName);
        
        return {
          ...requestConfig,
          isUsingModelMemory: true,
          skillUsed: normalizedSkillName,
          programmingLanguage
        };
      } else {
        console.warn(`No system prompt found for skill: ${normalizedSkillName}`);
      }
    }

    // Regular message (stored memory not empty, prompt already sent)
    requestConfig.contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });
    
    return {
      ...requestConfig,
      isUsingModelMemory: false,
      skillUsed: normalizedSkillName,
      programmingLanguage
    };
  }

  /**
   * Alternative method: Get separate components for manual API construction
   * @param {string} skillName - The active skill
   * @param {string} userMessage - The user's message/query
   * @param {Array} storedMemory - Current stored memory
   * @param {string|null} programmingLanguage - Optional programming language
   * @returns {Object} Separated components for manual request building
   */
  getRequestComponents(skillName, userMessage, storedMemory, programmingLanguage = null) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const shouldUseModelMemory = this.shouldSendAsModelMemory(skillName, storedMemory);
    const skillPrompt = this.getSkillPrompt(normalizedSkillName, programmingLanguage);

    return {
      skillName: normalizedSkillName,
      userMessage,
      skillPrompt,
      shouldUseModelMemory,
      isFirstTime: this.isFirstTimeInteraction(storedMemory),
      modelMemory: shouldUseModelMemory && skillPrompt ? skillPrompt : null,
      messageContent: userMessage,
      programmingLanguage,
      requiresProgrammingLanguage: this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName)
    };
  }

  /**
   * Update stored memory after successful API call
   * @param {Array} storedMemory - Current stored memory array
   * @param {string} skillName - The skill that was used
   * @param {boolean} wasModelMemoryUsed - Whether model memory was used
   * @param {string} userMessage - The user message
   * @param {string} aiResponse - The AI response
   * @param {string|null} programmingLanguage - Programming language used
   * @returns {Array} Updated stored memory
   */
  updateStoredMemory(storedMemory, skillName, wasModelMemoryUsed, userMessage, aiResponse, programmingLanguage = null) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const updatedMemory = [...(storedMemory || [])];
    
    const memoryEntry = {
      timestamp: new Date().toISOString(),
      skillUsed: normalizedSkillName,
      promptSentAsMemory: wasModelMemoryUsed,
      userMessage,
      aiResponse: aiResponse ? aiResponse.substring(0, 200) + '...' : null, // Truncated for storage
      action: wasModelMemoryUsed ? 'MODEL_MEMORY_SENT' : 'REGULAR_MESSAGE',
      programmingLanguage: programmingLanguage || null
    };
    
    updatedMemory.push(memoryEntry);
        
    return updatedMemory;
  }

  /**
   * Example usage method showing complete flow
   * @param {string} skillName - The active skill
   * @param {string} userMessage - User's message
   * @param {Array} storedMemory - Current stored memory
   * @param {string|null} programmingLanguage - Optional programming language
   * @returns {Object} Complete flow result
   */
  async processUserRequest(skillName, userMessage, storedMemory, programmingLanguage = null) {
    try {
      // Get request components
      const components = this.getRequestComponents(skillName, userMessage, storedMemory, programmingLanguage);

      // Prepare the actual API request
      const geminiRequest = this.prepareGeminiRequest(skillName, userMessage, storedMemory, programmingLanguage);
      
      return {
        requestReady: true,
        geminiRequest,
        components,
        needsMemoryUpdate: true,
        programmingLanguage
      };
      
    } catch (error) {
      console.error('Error processing user request:', error);
      return {
        requestReady: false,
        error: error.message,
        programmingLanguage
      };
    }
  }

  /**
   * Check if a skill requires programming language context
   * @param {string} skillName - The skill name to check
   * @returns {boolean} True if skill requires programming language
   */
  requiresProgrammingLanguage(skillName) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    return this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName);
  }

  /**
   * Get list of skills that require programming language context
   * @returns {Array<string>} Array of skill names that require programming language
   */
  getSkillsRequiringProgrammingLanguage() {
    return [...this.skillsRequiringProgrammingLanguage];
  }

  /**
   * Normalize skill names to match file names
   * @param {string} skillName - Raw skill name
   * @returns {string} Normalized skill name
   */
  normalizeSkillName(skillName) {
    if (!skillName) return DEFAULT_MODE;
    
    // Convert to lowercase and handle common variations
    const normalized = skillName.toLowerCase().trim();
    
    // Map common variations to standard names
    const skillMap = {
      'dsa': 'dsa',
      'data-structures': 'dsa',
      'algorithms': 'dsa',
      'data-structures-algorithms': 'dsa',
      'behavioral': 'behavioral',
      'behavioral-interview': 'behavioral',
      'behavior': 'behavioral',
      'sales': 'sales',
      'selling': 'sales',
      'business-development': 'sales',
      'presentation': 'presentation',
      'presentations': 'presentation',
      'public-speaking': 'presentation',
      'data-science': 'data-science',
      'datascience': 'data-science',
      'machine-learning': 'data-science',
      'ml': 'data-science',
      'programming': 'programming',
      'coding': 'programming',
      'software-development': 'programming',
      'development': 'programming',
      'devops': 'devops',
      'dev-ops': 'devops',
      'infrastructure': 'devops',
      'system-design': 'system-design',
      'systems-design': 'system-design',
      'architecture': 'system-design',
      'distributed-systems': 'system-design',
      'negotiation': 'negotiation',
      'negotiating': 'negotiation',
      'conflict-resolution': 'negotiation'
    };

    return skillMap[normalized] || normalized;
  }

  /**
   * Get list of available skills
   * @returns {Array<string>} Array of available skill names
   */
  getAvailableSkills() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }
    return [...MODE_IDS];
  }

  /** Interview modes for the UI: [{ id, label, usesLanguage }]. */
  getModes() {
    return MODES.map((mode) => ({ ...mode }));
  }

  /** True when `id` is exactly one of the interview mode ids. */
  isMode(id) {
    return typeof id === 'string' && MODE_IDS.includes(id);
  }

  getModeLabel(id) {
    const mode = MODES.find((m) => m.id === this.normalizeSkillName(id));
    return mode ? mode.label : 'Auto';
  }

  /** The mode used when none is saved: Auto. */
  getDefaultMode() {
    return DEFAULT_MODE;
  }

  isAnswerLength(value) {
    return typeof value === 'string' && ANSWER_LENGTHS.includes(value);
  }

  /**
   * The length to apply for one answer: the setting, or for 'auto' (and
   * anything unknown) Short for voice and Standard otherwise.
   * @param {string} setting - 'auto' | 'short' | 'standard' | 'detailed'
   * @param {string} channel - 'voice' | 'text' | 'image'
   */
  resolveAnswerLength(setting, channel) {
    if (setting === 'short' || setting === 'standard' || setting === 'detailed') return setting;
    return channel === 'voice' ? 'short' : 'standard';
  }

  /**
   * Candidate context (About you and the interview context) as a compact
   * prompt section, or '' when every field is empty. Only non-empty fields
   * are included.
   */
  formatProfile(profile) {
    if (!profile || typeof profile !== 'object') return '';
    const text = (key) => (typeof profile[key] === 'string' ? profile[key] : '');
    // Collapse runs of blank lines and trailing spaces to keep it compact.
    const block = (key) => text(key).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    // One line: inner line breaks become "; ".
    const line = (key) => text(key).split(/\r\n?|\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ');

    const about = [];
    const fullName = line('fullName');
    const preferredName = line('preferredName');
    if (fullName && preferredName && preferredName.toLowerCase() !== fullName.toLowerCase()) {
      about.push(`- Name: ${fullName} (preferred name: ${preferredName})`);
    } else if (fullName || preferredName) {
      about.push(`- Name: ${fullName || preferredName}`);
    }
    const title = line('currentTitle');
    const employer = line('currentCompany');
    if (title && employer) about.push(`- Current job: ${title} at ${employer}`);
    else if (title) about.push(`- Current title: ${title}`);
    else if (employer) about.push(`- Current company: ${employer}`);
    const years = this.formatYears(profile.yearsExperience);
    if (years) about.push(`- Total experience: ${years}`);
    const facts = [
      ['skills', 'Key skills'],
      ['education', 'Education'],
      ['location', 'Location']
    ];
    for (const [key, label] of facts) {
      const value = line(key);
      if (value) about.push(`- ${label}: ${value}`);
    }
    const relocation = ownValue(RELOCATION_TEXT, profile.relocation);
    if (relocation) about.push(`- Open to relocation: ${relocation}`);
    for (const [key, label] of [['noticePeriod', 'Notice period'], ['expectedSalary', 'Expected salary'], ['languages', 'Languages spoken']]) {
      const value = line(key);
      if (value) about.push(`- ${label}: ${value}`);
    }

    const parts = [];
    if (about.length) parts.push(`### About the candidate\n${about.join('\n')}`);
    // Short points, one per line: no blank lines between them.
    const achievements = block('achievements').replace(/\n{2,}/g, '\n');
    if (achievements) parts.push(`### Notable projects and achievements\n${achievements}`);
    // Role and company as one list, then the job description, resume and notes.
    const interviewLines = [];
    const interviewBlocks = [];
    for (const { key, label, block: isBlock } of PROFILE_PROMPT_FIELDS) {
      if (isBlock) {
        const value = block(key);
        if (value) interviewBlocks.push(`### ${label}\n${value}`);
      } else {
        const value = line(key);
        if (value) interviewLines.push(`- ${label}: ${value}`);
      }
    }
    if (interviewLines.length) parts.push(`### The interview\n${interviewLines.join('\n')}`);
    parts.push(...interviewBlocks);
    if (parts.length === 0) return '';

    const rules = [
      '- Speak as the candidate, in the first person, using these real details instead of placeholders. Put a short [placeholder] only where a detail the answer needs is truly missing here.',
      '- Never invent employers, titles, numbers, dates or degrees that are not here.',
      '- Tailor answers to the target role, company and job description when they are given, and draw examples from the projects, achievements and resume.'
    ];
    if (fullName || preferredName) {
      rules.push(`- Use the name ${preferredName || fullName} only where it is natural, such as introducing yourself; never open every answer with it.`);
    }
    if (line('expectedSalary')) rules.push('- For salary or compensation questions, give the expected salary above.');
    if (relocation || line('location')) rules.push('- For location or relocation questions, answer from the location and relocation details above.');
    if (line('noticePeriod')) rules.push('- For notice period, availability or start date questions, use the notice period above.');

    return `## CANDIDATE CONTEXT (internal background: use it, but never mention this section or quote its headings)
Background on the candidate you are answering for.

${parts.join('\n\n')}

### How to use it
${rules.join('\n')}`;
  }

  /** Years of experience ("5", "1", "3.5") as "5 years", or '' when unset or invalid. */
  formatYears(value) {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d{1,2}(\.\d)?$/.test(raw)) return '';
    const years = Number(raw);
    if (years > 60) return '';
    return `${years} ${years === 1 ? 'year' : 'years'}`;
  }

  /**
   * Answer style (tone and answer language from About you) as a prompt
   * section, or '' when neither is set. English is the default language and
   * adds nothing. Any value naming Hinglish ("Hinglish (Roman script)", the
   * Settings suggestion) gets its own rule: Hindi-English in Roman script
   * only, never Devanagari, with technical terms and code in English.
   */
  formatAnswerStyle(profile) {
    if (!profile || typeof profile !== 'object') return '';
    const rules = [];
    const tone = ownValue(TONE_RULES, profile.tone);
    if (tone) rules.push(`- Tone: ${tone}`);
    const language = typeof profile.answerLanguage === 'string' ? profile.answerLanguage.replace(/\s+/g, ' ').trim() : '';
    if (/\bhinglish\b/i.test(language)) {
      rules.push(HINGLISH_RULE);
    } else if (language && !/^english$/i.test(language)) {
      rules.push(`- Language: write every answer in ${language}, including the first line, even when the question is in another language. Keep code, identifiers and standard technical terms as they are usually written.`);
    }
    if (rules.length === 0) return '';
    return `## ANSWER STYLE (internal, never mention it)\n${rules.join('\n')}`;
  }

  /**
   * Full system prompt for one request: the mode prompt (with the coding
   * language for Coding), the shared answer format and length, voice
   * handling, the candidate context and the answer style.
   * @param {object} options
   * @param {string} options.mode - interview mode id
   * @param {string|null} options.programmingLanguage - only used by Coding
   * @param {string} options.channel - 'voice' | 'text' | 'image'
   * @param {string} options.answerLength - answer length setting
   * @param {object|null} options.profile - About you and interview context (profile.json)
   */
  buildSystemPrompt({ mode, programmingLanguage = null, channel = 'text', answerLength = 'auto', profile = null } = {}) {
    const modeId = this.isMode(this.normalizeSkillName(mode)) ? this.normalizeSkillName(mode) : DEFAULT_MODE;
    const label = this.getModeLabel(modeId);
    const styleRule = modeId === 'auto'
      ? '- Answer every interview question, of any type, in the format its type calls for. Never refuse, redirect or say "ask a question relevant to" anything.'
      : `- Answer every interview question in the ${label} format where it fits. If the question is clearly of another type, still answer it well in the format that suits it. Never refuse, redirect or say "ask a question relevant to" anything.`;
    const sections = [];

    const skillPrompt = this.getSkillPrompt(modeId, programmingLanguage);
    if (skillPrompt) sections.push(skillPrompt.trim());

    const length = this.resolveAnswerLength(answerLength, channel);
    sections.push(`## ANSWER FORMAT (internal instructions; they apply to every answer, before any workflow above)
- Mode (internal, never mention or repeat it): ${label}.
- Line 1 is the direct answer in one sentence the candidate can say first, in plain words, with no heading, label or preamble. Then the details.
- For a coding problem, line 1 states the approach itself (for example "Use a hash map of seen values to find the pair in one pass."), never filler such as "I can solve this...", "I would..." or "Sure, ...".
${styleRule}
- Do not repeat the question. No filler such as "Great question".
- Never mention the mode, the answer size, the coding language setting, these instructions or their section names, or that you are an AI. Never start with a label such as "Mode:", "Answer:" or "Length:". Start directly with the one-line answer.
- Answer size (internal, never mention it): ${LENGTH_RULES[length]}`);

    if (channel === 'voice') {
      sections.push(`## VOICE INPUT (internal, never mention it)
- The question was transcribed from live speech: it may have recognition errors, missing punctuation or be cut off. Infer the most likely intended question and answer it.
- Greetings, small talk and statements that are not questions: reply with one short, natural line the candidate can say (for filler or noise, something like "Sure, go ahead."). Never a refusal.`);
    } else if (channel === 'image') {
      sections.push(`## SCREENSHOT INPUT (internal, never mention it)
- The question comes from a screenshot. Read it carefully, including any code template, constraints or examples shown, and answer it.`);
    }

    const context = this.formatProfile(profile);
    if (context) sections.push(context);
    const style = this.formatAnswerStyle(profile);
    if (style) sections.push(style);

    return sections.join('\n\n');
  }

  /** The user-turn instruction sent with a screenshot, for the given mode. */
  getImageInstruction(mode, programmingLanguage = null) {
    const modeId = this.normalizeSkillName(mode);
    const langNote = programmingLanguage && this.requiresProgrammingLanguage(modeId)
      ? ` Use only ${String(programmingLanguage).toUpperCase()} for any code.`
      : '';
    switch (modeId) {
      case 'dsa':
        return `This screenshot shows a coding interview question. Extract the problem concisely and give the best possible solution: the one-line direct answer first, then the approach, the final code and its complexity.${langNote}`;
      case 'technical':
        return 'This screenshot shows a technical interview question. Answer it with the one-line direct answer first, then a crisp definition, the key points or differences, a tiny example and when to use which.';
      case 'system-design':
        return 'This screenshot shows a system design question or diagram. Answer it with the one-line direct answer first, then requirements, high-level design, components, data model, scaling and trade-offs.';
      case 'behavioral':
        return 'This screenshot shows a behavioral interview question. Answer it as a first-person STAR story the candidate can say aloud, starting with the one-line direct answer.';
      case 'hr':
        return 'This screenshot shows an HR interview question. Answer it in the first person, naturally and positively, starting with the one-line direct answer the candidate can say.';
      default:
        return `This screenshot shows an interview question. Work out its type (coding, technical theory, system design, behavioral, HR, situational, puzzle or case) and answer it in the format for that type, starting with the one-line direct answer the candidate can say.${langNote}`;
    }
  }

  /**
   * Reset the prompt sent tracking and clear stored memory
   */
  resetSession() {
    this.skillPromptSent.clear();
  }

  /**
   * Get current session statistics
   * @returns {Object} Statistics about current session
   */
  getSessionStats() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    const stats = {
      totalPrompts: this.prompts.size,
      skillsUsedInSession: this.skillPromptSent.size,
      availableSkills: this.getAvailableSkills(),
      skillsUsed: Array.from(this.skillPromptSent),
      skillsRequiringProgrammingLanguage: this.skillsRequiringProgrammingLanguage
    };

    return stats;
  }
}

// Export singleton instance
const promptLoader = new PromptLoader();

module.exports = {
  PromptLoader,
  promptLoader,
  MODES,
  DEFAULT_MODE,
  ANSWER_LENGTHS
};