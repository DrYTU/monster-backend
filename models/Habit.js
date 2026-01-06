const mongoose = require('mongoose');

const habitSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    rules: {
        type: String,
        default: '',
        trim: true
    },
    color: {
        type: String,
        default: '#4F46E5' // Default indigo-ish
    },
    // We prefer storing dates as "YYYY-MM-DD" strings for easy unique checking
    completedDates: {
        type: [String],
        default: []
    },
    // Tracks dates that already granted XP with timestamps (for undo window)
    // Format: [{ date: "YYYY-MM-DD", grantedAt: Date }]
    xpGrantedDates: {
        type: [{
            date: String,
            grantedAt: { type: Date, default: Date.now }
        }],
        default: []
    },
    currentStreak: {
        type: Number,
        default: 0
    },
    longestStreak: {
        type: Number,
        default: 0
    },
    // Reps Logic
    isRepBased: { type: Boolean, default: false },
    reps: { type: Number, default: 0 },
    repUnit: { type: String, default: 'reps' }, // e.g., 'pages', 'pushups'
    repIncrement: { type: Number, default: 0 }, // Amount to increase
    repIncrementFrequency: { type: String, default: 'none' }, // 'none', 'weekly', 'monthly'
    nextIncrementDate: { type: Date },
    createdAt: {
        type: Date,
        default: Date.now
    },
    // Social / Shared
    partnerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    sharedGroupId: {
        type: String, // Unique ID linking two habit copies
        default: null
    },
    // Battle Logic
    type: { type: String, enum: ['solo', 'battle'], default: 'solo' },
    battleStatus: { type: String, enum: ['pending', 'active', 'completed', 'rejected', 'waiting'], default: 'active' }, // waiting = creator waiting for partner
    battleDuration: { type: Number, default: 7 }, // days
    battleStartDate: { type: Date },
    battleWinner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isVisible: { type: Boolean, default: true } // Helper to hide pending invites if needed
});

module.exports = mongoose.model('Habit', habitSchema);
