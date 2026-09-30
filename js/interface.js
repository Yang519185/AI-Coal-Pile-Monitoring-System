/** Presentation-only coordination for the Studio interface. */
(function () {
    'use strict';

    function initInterface() {
        const sidebar = document.getElementById('sidebar');
        const sidebarToggle = document.getElementById('sidebarToggle');
        const config = document.getElementById('connectionCard');
        const dashboard = document.getElementById('page-dashboard');
        const narrow = window.matchMedia('(max-width: 680px)');
        const isMobile = () => document.documentElement.dataset.edition === 'mobile';
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const chartCard = dashboard.querySelector('.chart-card');

        // Keep reading/tab order aligned with the two-column visual layout.
        chartCard.after(dashboard.querySelector('.status-card'));

        const icons = {
            dashboard: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="14" width="6.5" height="6.5" rx="1.5"/>',
            coal3d: '<path d="m12 2.8 8.5 4.7v9L12 21.2l-8.5-4.7v-9L12 2.8Zm-8.5 4.7L12 12l8.5-4.5M12 12v9.2"/>',
            history: '<path d="M4 10a8.5 8.5 0 1 1 .8 6.2M4 4v6h6m2-3v5l3.5 2"/>',
            settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="#f9f9fb"/><circle cx="16" cy="12" r="2" fill="#f9f9fb"/><circle cx="8" cy="18" r="2" fill="#f9f9fb"/>',
            about: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5m0-9v.2"/>'
        };
        document.querySelectorAll('.nav-item').forEach(link => {
            const svg = link.querySelector('svg');
            svg.innerHTML = icons[link.dataset.page];
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.6');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            link.setAttribute('aria-label', link.textContent.trim());
            link.title = link.textContent.trim();
        });

        const scrim = document.createElement('button');
        scrim.type = 'button';
        scrim.className = 'sidebar-scrim';
        scrim.setAttribute('aria-label', '关闭导航');
        scrim.tabIndex = -1;
        document.body.appendChild(scrim);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'sidebar-close';
        closeButton.setAttribute('aria-label', '关闭导航');
        closeButton.textContent = '×';
        sidebar.querySelector('.sidebar-header').appendChild(closeButton);

        function closeNavigation() {
            if (!isMobile()) return;
            sidebar.classList.remove('collapsed');
            document.getElementById('dockMore').focus({ preventScroll: true });
        }

        let wasOpen = false;
        function syncNavigation() {
            const open = isMobile() && sidebar.classList.contains('collapsed');
            document.body.classList.toggle('nav-open', open);
            sidebar.inert = isMobile() && !open;
            sidebarToggle.setAttribute('aria-expanded', String(isMobile() ? open : !sidebar.classList.contains('collapsed')));
            document.getElementById('dockMore')?.setAttribute('aria-expanded', String(open));
            if (open && !wasOpen) setTimeout(() => closeButton.focus({ preventScroll: true }), 0);
            wasOpen = open;
        }
        scrim.addEventListener('click', closeNavigation);
        closeButton.addEventListener('click', closeNavigation);
        sidebarToggle.addEventListener('click', () => {
            if (isMobile() && sidebar.classList.contains('collapsed')) {
                closeButton.focus({ preventScroll: true });
            }
        });
        new MutationObserver(syncNavigation).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
        narrow.addEventListener('change', () => {
            sidebar.classList.remove('collapsed');
            syncNavigation();
        });
        syncNavigation();

        document.addEventListener('keydown', event => {
            if (!isMobile() || !sidebar.classList.contains('collapsed')) return;
            if (event.key === 'Escape') closeNavigation();
            if (event.key === 'Tab') {
                const focusable = [...sidebar.querySelectorAll('a, button')].filter(element => element.getClientRects().length);
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }
        });

        function syncActiveNavigation() {
            const activePage = document.querySelector('.nav-item.active')?.dataset.page;
            document.querySelectorAll('.nav-item').forEach(item => {
                if (item.dataset.page === activePage) item.setAttribute('aria-current', 'page');
                else item.removeAttribute('aria-current');
            });
            document.querySelectorAll('.dock-item[data-go-page]').forEach(item => {
                const active = item.dataset.goPage === activePage;
                item.classList.toggle('active', active);
                if (active) item.setAttribute('aria-current', 'page');
                else item.removeAttribute('aria-current');
            });
        }
        function goToPage(name) {
            if (window.navigateToPage) window.navigateToPage(name);
            else document.querySelector('.nav-item[data-page="' + name + '"]')?.click();
            syncActiveNavigation();
            window.scrollTo({ top: 0, behavior: 'instant' });
        }
        document.querySelectorAll('.nav-item').forEach(link => {
            link.addEventListener('click', () => {
                if (isMobile()) closeNavigation();
                window.scrollTo({ top: 0, behavior: 'instant' });
                syncActiveNavigation();
            });
        });
        syncActiveNavigation();
        const moreButton = document.getElementById('dockMore');
        moreButton?.setAttribute('aria-controls', 'sidebar');
        moreButton?.addEventListener('click', () => {
            sidebarToggle.click();
            if (isMobile() && sidebar.classList.contains('collapsed')) {
                sidebar.inert = false;
                setTimeout(() => {
                    if (sidebar.classList.contains('collapsed')) closeButton.focus({ preventScroll: true });
                }, 250);
            }
        });
        const editionLink = document.querySelector('.edition-switch');
        function syncEditionLink() {
            const mobile = isMobile();
            document.title = mobile ? 'IoT Monitor · 手机版' : 'IoT Monitor · 网页版';
            editionLink.href = mobile ? 'index.html?view=desktop' : 'mobile.html';
            editionLink.setAttribute('aria-label', mobile ? '切换到网页版' : '切换到手机版');
        }
        syncEditionLink();
        narrow.addEventListener('change', syncEditionLink);

        function openConfiguration() {
            if (!dashboard.classList.contains('active')) goToPage('dashboard');
            closeNavigation();
            config.open = true;
            config.scrollIntoView({ behavior: reduceMotion.matches ? 'instant' : 'smooth', block: 'start' });
            config.querySelector('summary').focus({ preventScroll: true });
        }
        document.querySelectorAll('[data-open-config]').forEach(button => button.addEventListener('click', openConfiguration));
        document.querySelectorAll('[data-go-page]').forEach(button => button.addEventListener('click', () => goToPage(button.dataset.goPage)));

        // Changing transport should also reveal its matching configuration.
        document.querySelectorAll('.mode-tab').forEach(button => {
            button.addEventListener('click', () => {
                if (window.getMonitorOverview?.().mode === button.dataset.mode) openConfiguration();
            });
        });

        const setText = (id, value) => {
            const element = document.getElementById(id);
            if (element && element.textContent !== value) element.textContent = value;
        };

        function refreshOverview() {
            const state = window.getMonitorOverview?.();
            if (!state) return;
            const connected = String(state.connected);
            if (document.body.dataset.connected !== connected) document.body.dataset.connected = connected;
            setText('sensorCountLabel', state.sensorCount + ' 个监测点');
            setText('overviewConnectionLabel', state.connected ? '设备已连接' : '等待设备连接');
            setText('sessionHeading', state.connected ? '连接已建立，持续感知。' : '随时准备，接收新数据。');
            setText('sessionDescription', state.connected ? state.activeSensorCount + ' / ' + state.sensorCount + ' 个监测点已接收温度数据' : '连接设备后，监测将在此开始。');
            setText('thresholdCaption', '报警阈值 ' + state.alarmLow + '°C — ' + state.alarmHigh + '°C');
            const host = document.getElementById(state.mode === 'emqx' ? 'emqxHost' : 'socketHost');
            setText('connectionSummaryValue', (state.mode === 'emqx' ? 'EMQX' : '网口直连') + ' · ' + (host.value.trim() || '待配置'));

            const empty = document.getElementById('chartEmptyState');
            empty.hidden = state.hasTemperatureData && typeof Chart !== 'undefined';
            chartCard.classList.toggle('chart-is-empty', !empty.hidden);
            if (typeof Chart === 'undefined') {
                setText('chartEmptyTitle', '图表暂时无法加载');
                setText('chartEmptyDescription', '请检查网络连接后刷新页面。');
            } else {
                setText('chartEmptyTitle', '等待第一条温度数据');
                setText('chartEmptyDescription', state.connected ? '设备已连接，正在等待传感器上传数据。' : '连接设备后，温度变化将在这里实时呈现。');
            }
            const date = new Date();
            const dateElement = document.getElementById('overviewDate');
            dateElement.dateTime = date.toISOString().slice(0, 10);
            setText('overviewDate', date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }));
        }
        refreshOverview();
        window.setInterval(() => { if (!document.hidden) refreshOverview(); }, 1000);
        document.addEventListener('visibilitychange', refreshOverview);
        config.addEventListener('input', refreshOverview);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initInterface);
    else initInterface();
})();
