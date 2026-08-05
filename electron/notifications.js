const { Notification } = require('electron');
const KoreanLunarCalendar = require('korean-lunar-calendar');

function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getTodayString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function solarFromLunar(year, month, day, intercalation) {
  const cal = new KoreanLunarCalendar();
  cal.setLunarDate(year, month, day, !!intercalation);
  const solar = cal.getSolarCalendar();
  if (!solar) return null;
  const m = String(solar.month).padStart(2, '0');
  const d = String(solar.day).padStart(2, '0');
  return `${solar.year}-${m}-${d}`;
}

function getAnniversarySolarDateForYear(ann, solarYear) {
  if (ann.isLunar) {
    const candidates = [];
    for (let ly = solarYear - 1; ly <= solarYear + 1; ly++) {
      const solar = solarFromLunar(ly, ann.lunarMonth, ann.lunarDay, !!ann.lunarIntercalation);
      if (solar && parseInt(solar.split('-')[0], 10) === solarYear) {
        candidates.push({ ly, solar });
      }
    }
    if (candidates.length === 0) return null;
    const preferred = candidates.find(c => c.ly === solarYear);
    if (preferred) return preferred.solar;
    return candidates.sort((a, b) => b.ly - a.ly)[0].solar;
  }
  if (!ann.dateStart) return null;
  const parts = ann.dateStart.split('-');
  return `${solarYear}-${parts[1]}-${parts[2]}`;
}

function isAnniversaryOnDate(ann, targetDateStr) {
  if (!ann.dateStart && !ann.isLunar) return false;
  if (ann.isLunar && ann.recurrence === 'yearly') {
    const year = parseInt(targetDateStr.split('-')[0], 10);
    return getAnniversarySolarDateForYear(ann, year) === targetDateStr;
  }
  if (!ann.dateStart) return false;
  const target = parseDateStr(targetDateStr);
  const start = parseDateStr(ann.dateStart);
  if (ann.recurrence === 'yearly') {
    return target.getMonth() === start.getMonth() && target.getDate() === start.getDate();
  }
  if (ann.recurrence === 'weekly') return target.getDay() === start.getDay();
  if (ann.recurrence === 'monthly') return target.getDate() === start.getDate();
  return ann.dateStart === targetDateStr;
}

function isTaskOnDate(task, targetDateStr) {
  if (task.completed || task.archived) return false;
  if (!task.dateStart) return false;
  if (task.recurrence && task.recurrence !== 'none') {
    if (targetDateStr < task.dateStart) return false;
    const targetDate = parseDateStr(targetDateStr);
    const startDate = parseDateStr(task.dateStart);
    if (task.recurrence === 'daily') return true;
    if (task.recurrence === 'weekly') return targetDate.getDay() === startDate.getDay();
    if (task.recurrence === 'monthly') return targetDate.getDate() === startDate.getDate();
    if (task.recurrence === 'yearly') {
      return targetDate.getMonth() === startDate.getMonth() && targetDate.getDate() === startDate.getDate();
    }
  }
  return task.dateStart === targetDateStr;
}

function isTodayPlanTask(task) {
  return task.category === '__today_plan__' || task.planDate;
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function collectDailyNotifications(storage, settings) {
  const today = getTodayString();
  const items = [];

  if (settings.notifyAnniversaries) {
    const anniversaries = readJson(storage, 'notion_app_anniversaries', []);
    anniversaries.forEach(ann => {
      if (!isAnniversaryOnDate(ann, today)) return;
      items.push({
        title: `기념일 · ${ann.title}`,
        body: ann.desc || '오늘은 기념일입니다.'
      });
    });
  }

  if (settings.notifyTasks) {
    const tasks = readJson(storage, 'notion_app_tasks', []);
    tasks.forEach(task => {
      if (isTodayPlanTask(task)) {
        const planDate = task.planDate || task.dateStart;
        if (planDate === today && !task.completed) {
          items.push({
            title: `오늘 할 일 · ${task.title}`,
            body: task.desc || '오늘 계획에 등록된 할 일입니다.'
          });
        }
        return;
      }
      if (isTaskOnDate(task, today)) {
        items.push({
          title: `일정 · ${task.title}`,
          body: task.desc || '오늘 예정된 업무입니다.'
        });
      }
    });
  }

  return items;
}

class NotificationScheduler {
  constructor(storage, getMainWindow) {
    this.storage = storage;
    this.getMainWindow = getMainWindow;
    this.timer = null;
    this.lastDailyKey = '';
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  start() {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), 60 * 1000);
  }

  tick() {
    const settings = this.storage.getDesktopSettings();
    if (!settings.notificationsEnabled) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dailyKey = `${getTodayString()}_${hhmm}`;

    if (hhmm !== settings.notifyTime) return;
    if (this.lastDailyKey === dailyKey) return;
    this.lastDailyKey = dailyKey;

    this.fireDailyNotifications(settings);
  }

  fireDailyNotifications(settings) {
    if (!Notification.isSupported()) return;
    const items = collectDailyNotifications(this.storage, settings);
    if (items.length === 0) return;

    items.slice(0, 8).forEach((item, index) => {
      setTimeout(() => {
        const n = new Notification({
          title: item.title,
          body: item.body,
          silent: index > 0
        });
        n.on('click', () => {
          const win = this.getMainWindow();
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
        });
      }, index * 400);
    });
  }

  notifyNow(title, body) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => {
      const win = this.getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

module.exports = { NotificationScheduler, collectDailyNotifications };
