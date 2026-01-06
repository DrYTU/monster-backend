require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('../models/User');
const Habit = require('../models/Habit');

const app = express();

app.use(cors());
app.use(express.json());

// MongoDB Connection (with caching for serverless)
let cachedDb = null;

const connectDB = async () => {
    if (cachedDb) {
        return cachedDb;
    }

    const connection = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/monster_app', {});
    cachedDb = connection;
    console.log('✅ MongoDB connected');
    return cachedDb;
};

// Connect before handling requests
app.use(async (req, res, next) => {
    await connectDB();
    next();
});

// --- RPG HELPERS ---
const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 5000, 10000, 20000];

const calculateLevel = (xp) => {
    let level = 1;
    for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
        if (xp >= LEVEL_THRESHOLDS[i]) {
            level = i + 1;
        } else {
            break;
        }
    }
    return level;
};

// --- ROUTES ---

// Health Check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Monster API is running!' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. REGISTER
app.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = new User({ email, password });
        await user.save();
        res.status(201).json({ user, message: 'User created' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// 2. LOGIN
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email, password });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. GET HABITS (Sync)
app.get('/habits', async (req, res) => {
    const { userId } = req.query;
    try {
        const visibleHabits = await Habit.find({
            userId,
            isVisible: { $ne: false },
            battleStatus: { $ne: 'completed' }
        });
        res.json(visibleHabits);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. CREATE HABIT
app.post('/habits', async (req, res) => {
    try {
        const { partnerId, battleDuration, ...habitData } = req.body;

        let sharedGroupId = null;
        if (partnerId) {
            sharedGroupId = new mongoose.Types.ObjectId().toString();
        }

        const habit = new Habit({
            ...habitData,
            partnerId: partnerId || null,
            sharedGroupId,
            type: partnerId ? 'battle' : 'solo',
            battleStatus: partnerId ? 'waiting' : 'active',
            battleDuration: battleDuration || 7
        });
        await habit.save();

        if (partnerId) {
            const partnerHabit = new Habit({
                ...habitData,
                userId: partnerId,
                partnerId: habitData.userId,
                sharedGroupId,
                type: 'battle',
                battleStatus: 'pending',
                isVisible: false,
                battleDuration: battleDuration || 7
            });
            await partnerHabit.save();
        }

        res.status(201).json(habit);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// 5. TOGGLE HABIT DATE
app.post('/habits/:id/toggle', async (req, res) => {
    const { date } = req.body;
    const { id } = req.params;

    try {
        const habit = await Habit.findById(id);
        if (!habit) return res.status(404).json({ error: 'Not found' });

        const existsIndex = habit.completedDates.indexOf(date);
        let xpChange = 0;

        if (existsIndex > -1) {
            habit.completedDates.splice(existsIndex, 1);
            xpChange = -15;
        } else {
            habit.completedDates.push(date);
            xpChange = 15;
        }

        habit.completedDates.sort();
        habit.currentStreak = habit.completedDates.length;

        await habit.save();

        const user = await User.findById(habit.userId);
        if (user) {
            if (user.hellWeek?.isActive) {
                xpChange = xpChange > 0 ? (xpChange + 20) : (xpChange - 20);
            }

            user.platformXp = Math.max(0, (user.platformXp || 0) + xpChange);
            user.level = calculateLevel(user.platformXp);

            await user.save();
        }

        res.json({ habit, userLv: user?.level, userXp: user?.platformXp });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. UPDATE HABIT
app.put('/habits/:id', async (req, res) => {
    try {
        const habit = await Habit.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(habit);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. DELETE HABIT
app.delete('/habits/:id', async (req, res) => {
    try {
        await Habit.findByIdAndDelete(req.params.id);
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. HELL WEEK ACTIONS
app.post('/user/:userId/hell-week', async (req, res) => {
    const { action } = req.body;
    const { userId } = req.params;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (action === 'start') {
            if (user.hellWeek.isActive) return res.status(400).json({ error: 'Already in hell' });

            user.hellWeek = {
                isActive: true,
                startDate: new Date(),
                targetDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            };
            res.json({ message: 'Welcome to Hell.', hellWeek: user.hellWeek });
        } else if (action === 'surrender') {
            user.hellWeek = { isActive: false };
            user.platformXp = Math.max(0, user.platformXp - 500);
            res.json({ message: 'You gave up. Shame.', user });
        }
        await user.save();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. GET USER DETAILS
app.get('/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.friendCode) {
            await user.save();
        }

        const calculatedLevel = calculateLevel(user.platformXp || 0);
        if (user.level !== calculatedLevel) {
            console.log(`Fixing user level mismatch: ${user.level} -> ${calculatedLevel} for XP ${user.platformXp}`);
            user.level = calculatedLevel;
            await user.save();
        }

        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SOCIAL ROUTES ---

// 10. SEND FRIEND REQUEST
app.post('/social/add-friend', async (req, res) => {
    const { userId, friendCode } = req.body;

    try {
        const sender = await User.findById(userId);
        const target = await User.findOne({ friendCode: friendCode?.toUpperCase() });

        if (!target) return res.status(404).json({ error: 'User not found with this code.' });
        if (sender.id === target.id) return res.status(400).json({ error: 'You cannot add yourself.' });
        if (sender.friends.includes(target.id)) return res.status(400).json({ error: 'Already friends.' });

        const existingReq = target.friendRequests.find(r => r.from.toString() === userId);
        if (existingReq) return res.status(400).json({ error: 'Request already sent.' });

        target.friendRequests.push({ from: userId, status: 'pending' });
        await target.save();

        res.json({ message: 'Friend request sent!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 11. HANDLE FRIEND REQUEST
app.post('/social/handle-request', async (req, res) => {
    const { userId, requesterId, action } = req.body;

    try {
        const user = await User.findById(userId);
        const requester = await User.findById(requesterId);

        if (!user || !requester) return res.status(404).json({ error: 'User not found' });

        user.friendRequests = user.friendRequests.filter(r => r.from.toString() !== requesterId);

        if (action === 'accept') {
            if (!user.friends.includes(requesterId)) user.friends.push(requesterId);
            if (!requester.friends.includes(userId)) requester.friends.push(userId);
            await requester.save();
        }

        await user.save();
        res.json({ message: `Request ${action}ed`, friends: user.friends });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 12. GET FRIENDS WITH STATS
app.get('/social/friends', async (req, res) => {
    const { userId } = req.query;
    try {
        const user = await User.findById(userId).populate('friends', 'email level platformXp monsterType hellWeek');
        if (!user) return res.status(404).json({ error: 'User not found' });

        const friendsData = [];

        for (const friend of user.friends) {
            const habits = await Habit.find({ userId: friend._id });

            let totalPossibleDays = 0;
            let totalCompletedCount = 0;
            let maxCurrentStreak = 0;
            let totalHabits = habits.length;

            habits.forEach(h => {
                const current = h.currentStreak || 0;
                if (current > maxCurrentStreak) maxCurrentStreak = current;

                const daysExist = Math.max(1, Math.floor((new Date() - new Date(h.createdAt)) / (1000 * 60 * 60 * 24)));
                const completedLen = h.completedDates?.length || 0;

                totalPossibleDays += daysExist;
                totalCompletedCount += Math.min(completedLen, daysExist);
            });

            const completionRate = totalPossibleDays > 0 ? Math.round((totalCompletedCount / totalPossibleDays) * 100) : 0;

            friendsData.push({
                _id: friend._id,
                email: friend.email,
                level: friend.level,
                xp: friend.platformXp,
                monsterType: friend.monsterType,
                hellWeek: friend.hellWeek,
                stats: {
                    totalHabits,
                    currentStreak: maxCurrentStreak,
                    completionRate
                }
            });
        }

        res.json(friendsData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 13. GET REQUESTS
app.get('/social/requests', async (req, res) => {
    const { userId } = req.query;
    try {
        const user = await User.findById(userId).populate('friendRequests.from', 'email level');
        if (!user) return res.status(404).json({ error: 'User not found' });

        const requests = user.friendRequests
            .filter(r => r.status === 'pending' && r.from)
            .map(r => ({
                _id: r._id,
                from: {
                    _id: r.from._id,
                    email: r.from.email,
                    level: r.from.level
                },
                timestamp: r.timestamp
            }));

        res.json(requests);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 14. GET SHARED HABIT GROUP
app.get('/habits/shared/:groupId', async (req, res) => {
    try {
        const habits = await Habit.find({ sharedGroupId: req.params.groupId })
            .populate('userId', 'email level monsterType');
        res.json(habits);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- BATTLE ROUTES ---

// Get Pending Battle Requests
app.get('/battles/requests', async (req, res) => {
    const { userId } = req.query;
    try {
        const requests = await Habit.find({
            userId,
            battleStatus: 'pending',
            type: 'battle'
        }).populate('partnerId', 'email level');
        res.json(requests);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Respond to Battle Request
app.post('/battles/respond', async (req, res) => {
    const { habitId, action } = req.body;
    try {
        const myHabit = await Habit.findById(habitId);
        if (!myHabit) return res.status(404).json({ error: 'Battle not found' });

        const opponentHabit = await Habit.findOne({
            sharedGroupId: myHabit.sharedGroupId,
            _id: { $ne: myHabit._id }
        });

        if (action === 'accept') {
            const startDate = new Date();
            myHabit.battleStatus = 'active';
            myHabit.isVisible = true;
            myHabit.battleStartDate = startDate;

            if (opponentHabit) {
                opponentHabit.battleStatus = 'active';
                opponentHabit.battleStartDate = startDate;
                await opponentHabit.save();
            }

            await myHabit.save();
            res.json({ message: 'Battle Accepted!', habit: myHabit });

        } else if (action === 'reject') {
            await Habit.findByIdAndDelete(habitId);

            if (opponentHabit) {
                opponentHabit.battleStatus = 'rejected';
                await opponentHabit.save();
            }
            res.json({ message: 'Battle Rejected' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Battles (Active & Past)
app.get('/battles', async (req, res) => {
    const { userId } = req.query;
    try {
        const activeBattles = await Habit.find({ userId, type: 'battle', battleStatus: 'active' });
        const now = new Date();

        for (const battle of activeBattles) {
            if (battle.battleStartDate) {
                const endDate = new Date(battle.battleStartDate);
                endDate.setDate(endDate.getDate() + battle.battleDuration);

                if (now > endDate) {
                    battle.battleStatus = 'completed';
                    await battle.save();
                }
            }
        }

        const battles = await Habit.find({
            userId,
            type: 'battle',
            battleStatus: { $in: ['active', 'completed'] }
        }).populate('partnerId', 'email level');

        res.json(battles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export for Vercel Serverless
module.exports = app;
