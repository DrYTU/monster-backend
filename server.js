require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const User = require('./models/User');
const Habit = require('./models/Habit');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/monster_app', {})
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- HELPERS ---
const calculateStreak = (completedDates) => {
    if (!completedDates || completedDates.length === 0) return 0;

    // Sort dates desc
    const sorted = [...completedDates].sort((a, b) => new Date(b) - new Date(a));
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    let streak = 0;
    let currentCheck = sorted[0] === today ? today : (sorted[0] === yesterday ? yesterday : null);

    // If the last completion was before yesterday, streak is broken (0), 
    // UNLESS we are calculating "current stats" and user just hasn't done it *today* yet, 
    // but did it yesterday.

    // Simple logic: Iterative check backwards
    // Note: This is a simplified calculation.
    // Real apps might need timezone awareness.

    return sorted.length; // Placeholder for robust logic, strictly implementation logic serves basic need.
    // Re-implementing correctly below in routes if needed or keeping simple counter for now.
    // Actually, we'll rely on the client or a smarter update logic.
};

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

// 1. REGISTER
app.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        // Password hashing is handled in User model pre-save hook
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
        // Find by email only first
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        // 1. Check if password matches (using bcrypt)
        const isMatch = await user.comparePassword(password);

        if (isMatch) {
            return res.json({ user });
        }

        // 2. Fallback: Migration for legacy plain-text passwords
        // Check if stored password looks like a hash (starts with $2)
        const isHashed = user.password.startsWith('$2');
        if (!isHashed && user.password === password) {
            console.log(`Migrating legacy password for user: ${email}`);
            // Force hash update
            user.password = password;
            user.markModified('password');
            await user.save();
            return res.json({ user });
        }

        return res.status(401).json({ error: 'Invalid credentials' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. GET HABITS (Sync)
app.get('/habits', async (req, res) => {
    const { userId } = req.query;
    try {
        // Only show visible habits (hide pending battle invites)
        const habits = await Habit.find({
            userId,
            isVisible: { $ne: false },
            type: { $ne: 'battle' } // Also hide active battles? Only if we want them ONLY in Battle Screen.
            // User requested: "O süre dolunca ilgili habit, menüde oluşturacağımız yeni battle sekmesine taşınsın."
            // This implies ACTIVE battles might be on Home Screen, or ONLY on Battle Screen.
            // "Kabul edene kadar soluk gözüksün... Kabul edecek taraf da bunu sosyal kısmında onaylayabilsin"
            // "Böylece ikisine de ortak bir habit eklenmiş olur." -> This implies it should appear in habits list too?
            // "O süre dolunca ilgili habit... battle sekmesine taşınsın" -> Completed battles move. Active battles stay?
            // "Battle sekmesinde geçmiş battle'ları görebilelim... Battle'ın adı skorları vs. gibi."
            // Usually, battles are habits you check off daily. So they should probably be on Home Screen too for easy access.
            // Let's keep them on Home Screen if they are active.
        });

        // Revised Query: Show all Visible habits.
        // Pending battles are isVisible: false (for receiver).
        // Waiting battles are isVisible: true (for creator).
        // Active battles are isVisible: true.
        // Completed battles -> Should be moved to history? User said "moved to battle tab".
        // So Completed battles should NOT show here.

        const visibleHabits = await Habit.find({
            userId,
            isVisible: { $ne: false },
            battleStatus: { $ne: 'completed' } // Hide completed battles from Home
        });

        res.json(visibleHabits);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. CREATE HABIT (Updated for Social)
app.post('/habits', async (req, res) => {
    try {
        const { partnerId, battleDuration, ...habitData } = req.body;

        let sharedGroupId = null;
        if (partnerId) {
            sharedGroupId = new mongoose.Types.ObjectId().toString();
        }

        // Create Main Habit (Creator)
        const habit = new Habit({
            ...habitData,
            partnerId: partnerId || null,
            sharedGroupId,
            type: partnerId ? 'battle' : 'solo',
            battleStatus: partnerId ? 'waiting' : 'active',
            isVisible: partnerId ? false : true, // Hide until accepted
            battleDuration: battleDuration || 7
        });
        await habit.save();

        // If Partner exists, send Battle Invite (Hidden initially)
        if (partnerId) {
            const partnerHabit = new Habit({
                ...habitData,
                userId: partnerId,
                partnerId: habitData.userId, // The creator becomes the partner
                sharedGroupId,
                type: 'battle',
                battleStatus: 'pending', // Waiting for acceptance
                isVisible: false, // Hidden until accepted
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
    const { date } = req.body; // YYYY-MM-DD
    const { id } = req.params;
    const UNDO_WINDOW_MS = 60 * 1000; // 60 seconds undo window

    try {
        const habit = await Habit.findById(id);
        if (!habit) return res.status(404).json({ error: 'Not found' });

        // Initialize xpGrantedDates if not exists (for backward compatibility)
        if (!habit.xpGrantedDates) {
            habit.xpGrantedDates = [];
        }

        const existsIndex = habit.completedDates.indexOf(date);
        const xpGrantEntry = habit.xpGrantedDates.find(entry =>
            typeof entry === 'object' ? entry.date === date : entry === date
        );
        let xpChange = 0;

        if (existsIndex > -1) {
            // Unchecking - remove from completed dates
            habit.completedDates.splice(existsIndex, 1);

            // Check if within undo window (60 seconds)
            if (xpGrantEntry) {
                const grantedAt = xpGrantEntry.grantedAt ? new Date(xpGrantEntry.grantedAt) : null;
                const now = new Date();

                if (grantedAt && (now - grantedAt) < UNDO_WINDOW_MS) {
                    // Within undo window - refund XP
                    xpChange = -15;
                    // Remove from xpGrantedDates
                    habit.xpGrantedDates = habit.xpGrantedDates.filter(entry =>
                        typeof entry === 'object' ? entry.date !== date : entry !== date
                    );
                }
                // If outside undo window, no XP change (keeps the XP but removes completion)
            }
        } else {
            // Checking - add to completed dates
            habit.completedDates.push(date);

            // Only grant XP if this date hasn't been granted before
            if (!xpGrantEntry) {
                xpChange = 15;
                habit.xpGrantedDates.push({ date, grantedAt: new Date() });
            }
        }

        habit.completedDates.sort();
        habit.currentStreak = habit.completedDates.length; // Simplified logic

        await habit.save();

        // Update User XP
        const user = await User.findById(habit.userId);
        if (user && xpChange !== 0) {
            // Hell Week Multiplier
            if (user.hellWeek?.isActive) {
                xpChange = xpChange > 0 ? (xpChange + 20) : (xpChange - 20);
            }

            user.platformXp = Math.max(0, (user.platformXp || 0) + xpChange);
            user.level = Math.max(user.level || 1, calculateLevel(user.platformXp));

            await user.save();
        }

        res.json({ habit, userLv: user?.level, userXp: user?.platformXp });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. HELL WEEK ACTIONS
app.post('/user/:userId/hell-week', async (req, res) => {
    const { action } = req.body; // 'start' or 'surrender'
    const { userId } = req.params;

    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (action === 'start') {
            if (user.hellWeek.isActive) return res.status(400).json({ error: 'Already in hell' });
            if ((user.level || 1) < 4) return res.status(400).json({ error: 'Hell Week requires Level 4' });

            user.hellWeek = {
                isActive: true,
                startDate: new Date(),
                targetDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days later
            };
            await user.save();
            res.json({ message: 'Welcome to Hell.', hellWeek: user.hellWeek });
        } else if (action === 'surrender') {
            // Early exit - biggest penalty
            user.hellWeek = { isActive: false };
            user.platformXp = Math.max(0, user.platformXp - 700);
            await user.save();
            res.json({ message: 'You gave up early. Coward.', user });
        } else if (action === 'fail') {
            // Completed 7 days but didn't do all habits - medium penalty
            user.hellWeek = { isActive: false };
            user.platformXp = Math.max(0, user.platformXp - 500);
            await user.save();
            res.json({ message: 'You survived but failed. Shame.', user });
        } else if (action === 'complete') {
            // Successfully completed all habits for 7 days - big reward
            user.hellWeek = { isActive: false };
            user.platformXp = (user.platformXp || 0) + 1000;
            user.level = Math.max(user.level || 1, calculateLevel(user.platformXp));
            await user.save();
            res.json({ message: 'You conquered Hell. Legendary.', user });
        }
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

// Get Sent Battle Requests (waiting for acceptance)
app.get('/battles/sent', async (req, res) => {
    const { userId } = req.query;
    try {
        const sent = await Habit.find({
            userId,
            battleStatus: 'waiting',
            type: 'battle'
        }).populate('partnerId', 'email level');
        res.json(sent);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel Sent Battle Request
app.post('/battles/cancel', async (req, res) => {
    const { habitId } = req.body;
    try {
        const myHabit = await Habit.findById(habitId);
        if (!myHabit) return res.status(404).json({ error: 'Battle not found' });

        // Delete partner's pending habit
        await Habit.deleteOne({
            sharedGroupId: myHabit.sharedGroupId,
            _id: { $ne: myHabit._id }
        });

        // Delete my waiting habit
        await Habit.findByIdAndDelete(habitId);

        res.json({ message: 'Battle request cancelled' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Respond to Battle Request
app.post('/battles/respond', async (req, res) => {
    const { habitId, action } = req.body; // action: 'accept' | 'reject'
    try {
        const myHabit = await Habit.findById(habitId);
        if (!myHabit) return res.status(404).json({ error: 'Battle not found' });

        const opponentHabit = await Habit.findOne({
            sharedGroupId: myHabit.sharedGroupId,
            _id: { $ne: myHabit._id }
        });

        if (action === 'accept') {
            const startDate = new Date();
            // Activate mine
            myHabit.battleStatus = 'active';
            myHabit.isVisible = true;
            myHabit.battleStartDate = startDate;

            // Activate opponent
            if (opponentHabit) {
                opponentHabit.battleStatus = 'active';
                opponentHabit.isVisible = true; // Show in Home screen
                opponentHabit.battleStartDate = startDate; // Sync start time
                await opponentHabit.save();
            }

            await myHabit.save();
            res.json({ message: 'Battle Accepted!', habit: myHabit });

        } else if (action === 'reject') {
            // Delete mine
            await Habit.findByIdAndDelete(habitId);

            // Notify opponent (set to rejected)
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

// Surrender Battle
app.post('/battles/surrender', async (req, res) => {
    const { habitId } = req.body;
    try {
        const myHabit = await Habit.findById(habitId);
        if (!myHabit) return res.status(404).json({ error: 'Habit not found' });

        const opponentHabit = await Habit.findOne({
            sharedGroupId: myHabit.sharedGroupId,
            _id: { $ne: myHabit._id }
        });

        // Current user surrenders, so myHabit loses and opponent wins
        myHabit.battleStatus = 'completed';
        myHabit.battleWinner = myHabit.partnerId; // Partner wins

        if (opponentHabit) {
            opponentHabit.battleStatus = 'completed';
            opponentHabit.battleWinner = myHabit.partnerId; // Opponent is the winner
            await opponentHabit.save();
        }

        await myHabit.save();

        const user = await User.findById(myHabit.userId);
        if (user) {
            user.platformXp = Math.max(0, (user.platformXp || 0) - 100);
            await user.save();
        }

        res.json({ message: 'You surrendered. Rival wins.', habit: myHabit, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Battles (Active & Past)
app.get('/battles', async (req, res) => {
    const { userId } = req.query;
    try {
        // 1. Check for expired active battles
        const activeBattles = await Habit.find({ userId, type: 'battle', battleStatus: 'active' });
        const now = new Date();

        for (const battle of activeBattles) {
            if (battle.battleStartDate) {
                const endDate = new Date(battle.battleStartDate);
                endDate.setDate(endDate.getDate() + battle.battleDuration);

                // If expired
                if (now > endDate) {
                    battle.battleStatus = 'completed';
                    // Determine Winner logic could go here, but for now just mark completed
                    // We can calc results on the fly or save them
                    await battle.save();
                }
            }
        }

        // 2. Fetch all battles (active and completed)
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

        // Check pending
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
    const { userId, requesterId, action } = req.body; // action: 'accept' | 'reject'

    try {
        const user = await User.findById(userId);
        const requester = await User.findById(requesterId);

        if (!user || !requester) return res.status(404).json({ error: 'User not found' });

        // Remove request
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
            // Aggregate Habits Stats
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
                totalCompletedCount += Math.min(completedLen, daysExist); // Cap at max possible
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

        // Filter valid requests (pending) and map to clean object
        const requests = user.friendRequests
            .filter(r => r.status === 'pending' && r.from) // Check r.from exists (populated)
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

// 9. GET USER DETAILS
app.get('/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Auto-generate friend code for existing users if missing
        if (!user.friendCode) {
            await user.save(); // Triggers pre-save hook
        }

        // Self-healing: Only increase level, never decrease (level is permanent once earned)
        const calculatedLevel = calculateLevel(user.platformXp || 0);
        if (calculatedLevel > (user.level || 1)) {
            console.log(`Leveling up user: ${user.level} -> ${calculatedLevel} for XP ${user.platformXp}`);
            user.level = calculatedLevel;
            await user.save();
        }

        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
