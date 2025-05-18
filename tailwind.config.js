/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      './public/**/*.html',
      './public/**/*.js',
      './public/**/*.css',
    ],
    theme: {
      extend: {
        fontFamily: {
          // Inter becomes the default font for `font-sans`
          sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        },
        colors: {
          primary: {
            light: '#60A5FA',   // blue-400
            DEFAULT: '#3B82F6', // blue-500
            dark: '#2563EB',    // blue-600
          },
          secondary: {
            light: '#34D399',   // emerald-400
            DEFAULT: '#10B981', // emerald-500
            dark: '#059669',    // emerald-600
          },
          neutral: {
            lightest: '#F9FAFB', // gray-50
            light: '#F3F4F6',    // gray-100
            DEFAULT: '#6B7280',  // gray-500
            dark: '#374151',     // gray-700
            darkest: '#111827',  // gray-900
          },
        },
      },
    },
    plugins: [],
  };
  