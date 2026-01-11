(function() {
    const commands = {
        'help': { action: 'help' },
        'whoami': { action: 'scroll', target: 'hero' },
        'cat readme.md': { action: 'scroll', target: 'about' },
        'cat readme': { action: 'scroll', target: 'about' },
        'readme': { action: 'scroll', target: 'about' },
        'ls skills': { action: 'scroll', target: 'about' },
        'ls skills/': { action: 'scroll', target: 'about' },
        'skills': { action: 'scroll', target: 'about' },
        'git log': { action: 'scroll', target: 'experience' },
        'git log --oneline career': { action: 'scroll', target: 'experience' },
        'experience': { action: 'scroll', target: 'experience' },
        'exp': { action: 'scroll', target: 'experience' },
        'find ~/projects': { action: 'scroll', target: 'projects' },
        'find projects': { action: 'scroll', target: 'projects' },
        'projects': { action: 'scroll', target: 'projects' },
        'ls blog': { action: 'scroll', target: 'blog' },
        'ls blog/': { action: 'scroll', target: 'blog' },
        'blog': { action: 'scroll', target: 'blog' },
        'tail -n 3 notes.log': { action: 'scroll', target: 'notes' },
        'notes': { action: 'scroll', target: 'notes' },
        'cat .interests': { action: 'scroll', target: 'interests' },
        'interests': { action: 'scroll', target: 'interests' },
        'cat .contact': { action: 'scroll', target: 'contact' },
        'contact': { action: 'scroll', target: 'contact' },
        'clear': { action: 'clear' },
        'cd blog': { action: 'navigate', target: '/blog/' },
        'cd notes': { action: 'navigate', target: '/notes/' },
        'cd ~': { action: 'navigate', target: '/' },
        'cd': { action: 'navigate', target: '/' },
        // Theme
        'theme light': { action: 'theme', target: 'light' },
        'theme dark': { action: 'theme', target: 'dark' },
        'light': { action: 'theme', target: 'light' },
        'dark': { action: 'theme', target: 'dark' },
        // Background
        'bg grid': { action: 'bg', target: 'grid' },
        'bg particles': { action: 'bg', target: 'particles' },
        'bg matrix': { action: 'bg', target: 'matrix' },
        'bg scanlines': { action: 'bg', target: 'scanlines' },
        'bg none': { action: 'bg', target: 'none' },
        // Easter eggs
        'sudo': { action: 'easter', key: 'sudo' },
        'sudo rm -rf /': { action: 'easter', key: 'sudo' },
        'rm -rf /': { action: 'easter', key: 'rm' },
        'exit': { action: 'easter', key: 'exit' },
        'vim': { action: 'easter', key: 'vim' },
        'emacs': { action: 'easter', key: 'emacs' },
        'nano': { action: 'easter', key: 'nano' },
        'coffee': { action: 'easter', key: 'coffee' },
        'make coffee': { action: 'easter', key: 'coffee' },
        'ping': { action: 'easter', key: 'ping' },
        'hello': { action: 'easter', key: 'hello' },
        'hi': { action: 'easter', key: 'hello' },
        'ls': { action: 'easter', key: 'ls' },
        'ls -la': { action: 'easter', key: 'lsla' },
        'pwd': { action: 'easter', key: 'pwd' },
        'fortune': { action: 'easter', key: 'fortune' },
        'sl': { action: 'easter', key: 'sl' },
        'man': { action: 'easter', key: 'man' },
        'hire': { action: 'easter', key: 'hire' },
        'hire me': { action: 'easter', key: 'hire' }
    };

    const easterEggs = {
        'sudo': 'nice try. no root for you.',
        'rm': '🔥 just kidding, this is a static site.',
        'exit': 'there is no escape. try closing the tab.',
        'vim': 'error: you are now trapped. good luck.',
        'emacs': 'M-x butterfly... just kidding, use vim.',
        'nano': 'finally, someone with taste.',
        'coffee': '☕ brewing caffeine.exe...\n[==========>         ] 50%\njust kidding, go touch grass.',
        'ping': 'pong',
        'hello': 'hey there 👋',
        'ls': 'README.md  skills/  blog/  notes/  .contact\n\ntry: ls skills/, ls blog/, cat README.md',
        'lsla': 'drwxr-xr-x  mikhail mass_code\n-rw-r--r--  mikhail mass_bugs\n-rw-r--r--  mikhail mass_coffee',
        'pwd': '/home/mikhail/trying-to-look-cool',
        'fortune': null, // handled specially
        'sl': '🚂 choo choo! (you meant ls)',
        'man': 'this man needs mass sleep.',
        'hire': '📧 mikhwall@gmail.com\nlet\'s build something cool.'
    };

    const fortunes = [
        '"Any fool can write code that a computer can understand. Good programmers write code that humans can understand." - Martin Fowler',
        '"First, solve the problem. Then, write the code." - John Johnson',
        'bugs are just mass features in disguise.',
        '"It works on my machine." - Every Developer',
        '"There are only two hard things in CS: cache invalidation, naming things, and off-by-one errors."',
        'git push --force is never the answer. except when it is.',
        'console.log("here") console.log("here2") console.log("why") - You, debugging'
    ];

    // Commands shown in tab completion (canonical forms)
    const completions = [
        'help',
        'whoami',
        'cat README.md',
        'ls skills/',
        'git log',
        'find ~/projects',
        'ls blog/',
        'cat .interests',
        'cat .contact',
        'cd blog',
        'cd notes',
        'theme light',
        'theme dark',
        'bg grid',
        'bg particles',
        'bg matrix',
        'bg scanlines',
        'bg none',
        'clear'
    ];

    let tabMatches = [];
    let tabIndex = 0;

    const helpText = `Available commands:
  whoami          - about me
  cat README.md   - intro
  ls skills/      - technical skills
  git log         - work experience
  find ~/projects - projects
  ls blog/        - blog posts
  cat .interests  - life outside code
  cat .contact    - contact info
  cd blog         - go to blog
  cd notes        - go to notes
  theme light     - switch to light mode
  theme dark      - switch to dark mode
  clear           - clear & scroll top
  help            - show this message`;

    let history = [];
    let historyIndex = -1;
    let input = null;
    let output = null;

    function init() {
        input = document.querySelector('.terminal-input');
        output = document.querySelector('.terminal-output');

        if (!input) return;

        input.addEventListener('keydown', handleKeydown);

        // Focus input only when clicking near the input area, not the whole page
        document.querySelector('.terminal-input-line')?.addEventListener('click', function(e) {
            input.focus();
        });
    }

    function handleKeydown(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            handleTabCompletion();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const cmd = input.value.trim().toLowerCase();
            if (cmd) {
                executeCommand(cmd);
                history.unshift(cmd);
                if (history.length > 20) history.pop();
            }
            input.value = '';
            historyIndex = -1;
            resetTabState();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex < history.length - 1) {
                historyIndex++;
                input.value = history[historyIndex];
            }
            resetTabState();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                input.value = history[historyIndex];
            } else {
                historyIndex = -1;
                input.value = '';
            }
            resetTabState();
        } else {
            // Reset tab state on any other key
            resetTabState();
        }
    }

    function handleTabCompletion() {
        const current = input.value.trim().toLowerCase();

        // If we're cycling through existing matches
        if (tabMatches.length > 0 && current === tabMatches[tabIndex].toLowerCase()) {
            tabIndex = (tabIndex + 1) % tabMatches.length;
            input.value = tabMatches[tabIndex];
            return;
        }

        // Find new matches
        tabMatches = completions.filter(cmd =>
            cmd.toLowerCase().startsWith(current)
        );
        tabIndex = 0;

        if (tabMatches.length === 1) {
            input.value = tabMatches[0];
        } else if (tabMatches.length > 1) {
            input.value = tabMatches[0];
            showOutput(tabMatches.join('  '), 'help');
        }
    }

    function resetTabState() {
        tabMatches = [];
        tabIndex = 0;
    }

    function executeCommand(cmd) {
        const command = commands[cmd];

        if (!command) {
            showOutput(`command not found: ${cmd}. Type 'help' for commands.`, 'error');
            return;
        }

        switch (command.action) {
            case 'scroll':
                scrollToSection(command.target);
                showOutput(`→ ${command.target}`, 'success');
                break;
            case 'navigate':
                showOutput(`→ ${command.target}`, 'success');
                setTimeout(() => window.location.href = command.target, 200);
                break;
            case 'clear':
                clearOutput();
                window.scrollTo({ top: 0, behavior: 'smooth' });
                break;
            case 'help':
                showOutput(helpText, 'help');
                break;
            case 'theme':
                if (typeof setTheme === 'function') {
                    setTheme(command.target);
                    showOutput(`theme set to ${command.target}`, 'success');
                }
                break;
            case 'bg':
                if (typeof setBackground === 'function') {
                    setBackground(command.target);
                    showOutput(`background set to ${command.target}`, 'success');
                }
                break;
            case 'easter':
                const eggKey = command.key;
                let msg;
                if (eggKey === 'fortune') {
                    msg = fortunes[Math.floor(Math.random() * fortunes.length)];
                } else {
                    msg = easterEggs[eggKey];
                }
                showOutput(msg, 'help');
                break;
        }
    }

    function scrollToSection(target) {
        const sectionMap = {
            'hero': '.section:first-of-type',
            'about': '#about',
            'experience': '#experience',
            'projects': '#projects',
            'blog': '.section:has(.command:contains("blog")), .section:nth-last-of-type(4)',
            'notes': '.section:has(.command:contains("notes")), .section:nth-last-of-type(3)',
            'contact': '#contact'
        };

        let el = null;

        // Try ID first
        if (target === 'hero') {
            el = document.querySelector('.terminal-body .section');
        } else if (['blog', 'notes'].includes(target)) {
            // Find section by command text
            const sections = document.querySelectorAll('.section');
            for (const section of sections) {
                const cmdText = section.querySelector('.command')?.textContent || '';
                if (target === 'blog' && cmdText.includes('ls') && section.textContent.includes('blog')) {
                    el = section;
                    break;
                }
                if (target === 'notes' && (cmdText.includes('tail') || section.textContent.includes('notes.log'))) {
                    el = section;
                    break;
                }
            }
        } else {
            el = document.querySelector(`#${target}`);
        }

        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function showOutput(text, type) {
        if (!output) return;

        output.textContent = text;
        output.className = 'terminal-output';
        if (type) output.classList.add(type);
        output.style.display = 'block';

        // Auto-hide after delay (except help)
        if (type !== 'help') {
            setTimeout(() => {
                output.style.display = 'none';
            }, 2000);
        }
    }

    function clearOutput() {
        if (output) {
            output.style.display = 'none';
            output.textContent = '';
        }
    }

    // Init when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
