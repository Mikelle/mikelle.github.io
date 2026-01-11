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
        'cat .contact': { action: 'scroll', target: 'contact' },
        'contact': { action: 'scroll', target: 'contact' },
        'clear': { action: 'clear' },
        'cd blog': { action: 'navigate', target: '/blog/' },
        'cd notes': { action: 'navigate', target: '/notes/' },
        'cd ~': { action: 'navigate', target: '/' },
        'cd': { action: 'navigate', target: '/' }
    };

    const helpText = `Available commands:
  whoami          - about me
  cat README.md   - intro
  ls skills/      - technical skills
  git log         - work experience
  find ~/projects - projects
  ls blog/        - blog posts
  cat .contact    - contact info
  cd blog         - go to blog
  cd notes        - go to notes
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

        // Focus input when clicking anywhere in terminal body
        document.querySelector('.terminal-body')?.addEventListener('click', function(e) {
            if (!e.target.closest('a') && !e.target.closest('input')) {
                input.focus();
            }
        });

        // Initial focus (with small delay for page load)
        setTimeout(() => input.focus(), 100);
    }

    function handleKeydown(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const cmd = input.value.trim().toLowerCase();
            if (cmd) {
                executeCommand(cmd);
                history.unshift(cmd);
                if (history.length > 20) history.pop();
            }
            input.value = '';
            historyIndex = -1;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex < history.length - 1) {
                historyIndex++;
                input.value = history[historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                input.value = history[historyIndex];
            } else {
                historyIndex = -1;
                input.value = '';
            }
        }
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
