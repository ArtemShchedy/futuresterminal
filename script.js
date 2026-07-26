document.addEventListener("DOMContentLoaded", () => {
    // Add simple random fluctuation to the green/red numbers in the dashboard mock
    const moLines = document.querySelectorAll('.down-text, .up-text, .side-text');
    
    setInterval(() => {
        moLines.forEach(el => {
            if (Math.random() > 0.7) return; // 30% chance to update this tick
            
            const text = el.innerText;
            const match = text.match(/([+-]?\d+\.\d+)%/);
            if (match) {
                let currentVal = parseFloat(match[1]);
                // Add a tiny variation
                let fluctuation = (Math.random() * 0.1) - 0.05;
                let newVal = (currentVal + fluctuation).toFixed(2);
                
                // Keep sign
                let prefix = newVal > 0 ? '+' : '';
                el.innerText = text.replace(match[0], `${prefix}${newVal}%`);
            }
        });
    }, 2000);

    // Confidence and RSI random update
    const vals = document.querySelectorAll('.val');
    setInterval(() => {
        vals.forEach(el => {
            if (Math.random() > 0.8) return;
            
            let currentStr = el.innerText;
            if (currentStr.includes('%')) {
                let val = parseInt(currentStr);
                let fluctuation = Math.floor(Math.random() * 3) - 1; // -1, 0, +1
                let newVal = Math.min(100, Math.max(0, val + fluctuation));
                el.innerText = newVal + '%';
            } else {
                let val = parseInt(currentStr);
                let fluctuation = Math.floor(Math.random() * 3) - 1; // -1, 0, +1
                let newVal = Math.min(100, Math.max(0, val + fluctuation));
                el.innerText = newVal;
            }
        });
    }, 3000);
});
