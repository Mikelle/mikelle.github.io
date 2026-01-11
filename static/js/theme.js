(function() {
    // Apply saved theme immediately to prevent flash
    const saved = localStorage.getItem('theme');
    if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
    }
})();

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    setTheme(next);
}

function setTheme(theme) {
    if (theme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'dark');
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('theme', 'light');
    }
    updateToggleIcon();
}

function updateToggleIcon() {
    const btn = document.querySelector('.theme-toggle');
    if (!btn) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    btn.textContent = isLight ? '☾' : '☀';
}

// Update icon on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        updateToggleIcon();
        initActiveNav();
    });
} else {
    updateToggleIcon();
    initActiveNav();
}

// Highlight active nav section on scroll
function initActiveNav() {
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.terminal-nav a[href^="#"]');

    if (!sections.length || !navLinks.length) return;

    function updateActiveNav() {
        const scrollPos = window.scrollY + 100;

        sections.forEach(section => {
            const top = section.offsetTop;
            const height = section.offsetHeight;
            const id = section.getAttribute('id');

            if (scrollPos >= top && scrollPos < top + height) {
                navLinks.forEach(link => {
                    link.classList.remove('active');
                    if (link.getAttribute('href') === '#' + id) {
                        link.classList.add('active');
                    }
                });
            }
        });
    }

    window.addEventListener('scroll', updateActiveNav);
    updateActiveNav();
}
