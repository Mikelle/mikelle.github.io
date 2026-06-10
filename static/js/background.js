// Background Effects
(function() {
    let matrixInterval = null;
    let particlesInterval = null;
    let listenerCleanups = [];

    // Read effect colors from the active theme; refresh when the theme changes
    const colors = { bg: '#0d1117', green: '#3fb950' };

    function refreshColors() {
        const style = getComputedStyle(document.documentElement);
        colors.bg = style.getPropertyValue('--bg').trim() || colors.bg;
        colors.green = style.getPropertyValue('--green').trim() || colors.green;
    }

    function withAlpha(hex, alpha) {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    refreshColors();
    new MutationObserver(refreshColors).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
    });

    function addListener(target, event, handler) {
        target.addEventListener(event, handler);
        listenerCleanups.push(() => target.removeEventListener(event, handler));
    }

    window.setBackground = function(type) {
        // Clear existing effects
        clearEffects();

        if (type === 'none') {
            document.documentElement.removeAttribute('data-bg');
            localStorage.removeItem('bg');
            return;
        }

        document.documentElement.setAttribute('data-bg', type);
        localStorage.setItem('bg', type);

        if (type === 'matrix') {
            initMatrix();
        } else if (type === 'particles') {
            initParticles();
        }
    };

    function clearEffects() {
        // Remove canvases
        document.getElementById('matrix-canvas')?.remove();
        document.getElementById('particles-canvas')?.remove();

        // Remove window listeners added by the previous effect
        listenerCleanups.forEach(cleanup => cleanup());
        listenerCleanups = [];

        // Clear intervals
        if (matrixInterval) {
            clearInterval(matrixInterval);
            matrixInterval = null;
        }
        if (particlesInterval) {
            cancelAnimationFrame(particlesInterval);
            particlesInterval = null;
        }
    }

    function initMatrix() {
        const canvas = document.createElement('canvas');
        canvas.id = 'matrix-canvas';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');

        const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';
        const fontSize = 14;
        let columns = 0;
        let drops = [];

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            columns = Math.floor(canvas.width / fontSize);
            drops = Array(columns).fill(1);
        }
        resize();
        addListener(window, 'resize', resize);

        function draw() {
            ctx.fillStyle = withAlpha(colors.bg, 0.05);
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = colors.green;
            ctx.font = fontSize + 'px monospace';

            for (let i = 0; i < drops.length; i++) {
                const char = chars[Math.floor(Math.random() * chars.length)];
                ctx.fillText(char, i * fontSize, drops[i] * fontSize);

                if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                    drops[i] = 0;
                }
                drops[i]++;
            }
        }

        matrixInterval = setInterval(draw, 50);
    }

    function initParticles() {
        const canvas = document.createElement('canvas');
        canvas.id = 'particles-canvas';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');

        let mouse = { x: null, y: null };
        const mouseRadius = 150;

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        resize();
        addListener(window, 'resize', resize);

        addListener(window, 'mousemove', (e) => {
            mouse.x = e.x;
            mouse.y = e.y;
        });

        addListener(window, 'mouseout', () => {
            mouse.x = null;
            mouse.y = null;
        });

        const particles = [];
        const particleCount = 60;
        const connectionDistance = 150;

        for (let i = 0; i < particleCount; i++) {
            particles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                vx: (Math.random() - 0.5) * 0.5,
                vy: (Math.random() - 0.5) * 0.5,
                radius: Math.random() * 2 + 1
            });
        }

        function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Update and draw particles
            particles.forEach(p => {
                // Mouse attraction
                if (mouse.x !== null && mouse.y !== null) {
                    const dx = mouse.x - p.x;
                    const dy = mouse.y - p.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < mouseRadius) {
                        const force = (mouseRadius - dist) / mouseRadius;
                        p.vx += (dx / dist) * force * 0.02;
                        p.vy += (dy / dist) * force * 0.02;
                    }
                }

                // Apply velocity with damping
                p.vx *= 0.99;
                p.vy *= 0.99;

                p.x += p.vx;
                p.y += p.vy;

                // Bounce off edges
                if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
                if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fillStyle = colors.green;
                ctx.fill();
            });

            // Draw connections between particles
            ctx.strokeStyle = withAlpha(colors.green, 0.2);
            ctx.lineWidth = 1;

            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < connectionDistance) {
                        ctx.beginPath();
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.stroke();
                    }
                }
            }

            // Draw connections from mouse to nearby particles
            if (mouse.x !== null && mouse.y !== null) {
                ctx.strokeStyle = withAlpha(colors.green, 0.4);
                particles.forEach(p => {
                    const dx = mouse.x - p.x;
                    const dy = mouse.y - p.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < mouseRadius) {
                        ctx.beginPath();
                        ctx.moveTo(mouse.x, mouse.y);
                        ctx.lineTo(p.x, p.y);
                        ctx.stroke();
                    }
                });
            }

            particlesInterval = requestAnimationFrame(draw);
        }

        draw();
    }

    // Load saved background on page load (default: particles)
    // Respect reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
        // Don't animate for users who prefer reduced motion
        return;
    }

    const saved = localStorage.getItem('bg');
    const bg = saved !== null ? saved : 'particles';
    if (bg && bg !== 'none') {
        setBackground(bg);
    }
})();
