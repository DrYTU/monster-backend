const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true
  },
  // RPG System
  platformXp: {
    type: Number,
    default: 0
  },
  level: {
    type: Number,
    default: 1
  },
  monsterType: {
    type: String,
    default: 'shadow_beast' // Can be customized later
  },
  hellWeek: {
    isActive: { type: Boolean, default: false },
    startDate: { type: Date },
    targetDate: { type: Date }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  // Social System
  friendCode: {
    type: String,
    unique: true,
    sparse: true // Allows null/undefined for existing users temporarily
  },
  friends: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  friendRequests: [{
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['pending', 'rejected'], default: 'pending' },
    timestamp: { type: Date, default: Date.now }
  }]
});

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  } catch (err) {
    throw new Error(err);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Generate Friend Code pre-save
userSchema.pre('save', async function () {
  if (!this.friendCode) {
    console.log("Generating friend code for user:", this._id);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    let isUnique = false;

    // Try generating a unique code (simple loop to ensure uniqueness)
    while (!isUnique) {
      code = '';
      for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }

      // Use this.constructor to access the model
      const existing = await this.constructor.findOne({ friendCode: code });
      if (!existing) {
        isUnique = true;
      }
    }
    this.friendCode = code;
  }
});

module.exports = mongoose.model('User', userSchema);
